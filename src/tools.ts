/**
 * Déclaration des outils MCP exposés à Claude.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isDatabaseAllowedByConfig, type AppConfig } from "./config.js";
import type { Database } from "./db.js";
import { formatSqlType, markdownHeader, markdownRow, objectsTable } from "./format.js";
import { assertReadOnlyQuery, ReadOnlyViolation } from "./sqlGuard.js";

type Row = Record<string, unknown>;
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Budget de caractères d'une réponse execute_query, pour ne pas saturer le contexte du modèle. */
const MAX_OUTPUT_CHARS = 120_000;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

class UserError extends Error {}

async function run(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    return { content: [{ type: "text", text: describeError(err) }], isError: true };
  }
}

function describeError(err: unknown): string {
  if (err instanceof UserError || err instanceof ReadOnlyViolation) return err.message;
  const e = err as {
    message?: string;
    number?: number;
    lineNumber?: number;
    code?: string;
    precedingErrors?: Array<{ message?: string; number?: number; lineNumber?: number }>;
  };
  const lines: string[] = [];
  for (const pe of e?.precedingErrors ?? []) {
    lines.push(sqlErrorLine(pe));
  }
  lines.push(sqlErrorLine(e));
  if (e?.code === "ETIMEOUT") {
    lines.push("→ Délai dépassé : simplifiez la requête, filtrez davantage, ou augmentez MSSQL_QUERY_TIMEOUT_MS.");
  }
  return lines.join("\n");
}

function sqlErrorLine(e: { message?: string; number?: number; lineNumber?: number } | undefined): string {
  if (!e) return "Erreur inconnue.";
  const parts: string[] = [];
  if (e.number) parts.push(`Erreur SQL ${e.number}`);
  if (e.lineNumber) parts.push(`ligne ${e.lineNumber}`);
  const prefix = parts.length > 0 ? `${parts.join(", ")} : ` : "";
  return `${prefix}${e.message ?? String(e)}`;
}

function likePattern(pattern: string | undefined): string | null {
  if (pattern === undefined || pattern.trim() === "") return null;
  const p = pattern.trim();
  return p.includes("%") ? p : `%${p}%`;
}

/** Découpe "schema.objet" / "[schema].[objet]" / "base.schema.objet" (le préfixe base est ignoré). */
export function parseObjectName(raw: string, schema?: string): { schema: string | null; name: string } {
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === "[" || c === '"') {
      const close = c === "[" ? "]" : '"';
      i++;
      while (i < raw.length) {
        if (raw[i] === close) {
          if (raw[i + 1] === close) {
            current += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        current += raw[i++];
      }
      continue;
    }
    if (c === ".") {
      parts.push(current.trim());
      current = "";
      i++;
      continue;
    }
    current += c;
    i++;
  }
  parts.push(current.trim());

  const name = parts[parts.length - 1];
  const parsedSchema = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const finalSchema = schema?.trim() || parsedSchema || null;
  if (!name) throw new UserError(`Nom d'objet invalide : "${raw}".`);
  return { schema: finalSchema, name };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Requêtes de métadonnées
// ---------------------------------------------------------------------------

const OBJECT_TYPE_LABEL = `CASE o.type
    WHEN 'U' THEN 'TABLE' WHEN 'V' THEN 'VIEW' WHEN 'P' THEN 'PROCEDURE' WHEN 'PC' THEN 'PROCEDURE (CLR)'
    WHEN 'FN' THEN 'FUNCTION (scalaire)' WHEN 'IF' THEN 'FUNCTION (table inline)' WHEN 'TF' THEN 'FUNCTION (table)'
    WHEN 'FS' THEN 'FUNCTION (CLR scalaire)' WHEN 'FT' THEN 'FUNCTION (CLR table)' WHEN 'TR' THEN 'TRIGGER'
    WHEN 'SN' THEN 'SYNONYM' ELSE o.type_desc END`;

const LIST_DATABASES_SQL = `
SELECT d.name, d.state_desc, d.recovery_model_desc, d.compatibility_level, d.collation_name,
       d.is_read_only, CONVERT(varchar(10), d.create_date, 23) AS create_date, d.database_id
FROM sys.databases AS d
WHERE HAS_DBACCESS(d.name) = 1 AND d.state_desc = 'ONLINE'
ORDER BY d.name;`;

interface DatabaseRow {
  name: string;
  state_desc: string;
  recovery_model_desc: string | null;
  compatibility_level: number | null;
  collation_name: string | null;
  is_read_only: boolean;
  create_date: string;
  database_id: number;
}

interface ResolvedObject {
  object_id: number;
  schema_name: string;
  object_name: string;
  type: string;
  type_label: string;
}

async function listAccessibleDatabases(db: Database, config: AppConfig): Promise<DatabaseRow[]> {
  const [rows] = await db.metadata<DatabaseRow>(db.defaultDatabase, LIST_DATABASES_SQL);
  return rows.filter((r) => isDatabaseAllowedByConfig(config, r.name));
}

function assertDatabase(config: AppConfig, database: string): void {
  if (!isDatabaseAllowedByConfig(config, database)) {
    throw new UserError(
      `La base "${database}" n'est pas autorisée par la configuration de ce serveur MCP. Utilisez list_databases pour voir les bases disponibles.`,
    );
  }
}

async function resolveObject(
  db: Database,
  database: string,
  rawName: string,
  schema: string | undefined,
  types: string[],
  kindLabel: string,
): Promise<ResolvedObject> {
  const { schema: schemaName, name } = parseObjectName(rawName, schema);
  const typeList = types.map((t) => `'${t}'`).join(", ");
  const [matches] = await db.metadata<ResolvedObject>(
    database,
    `SELECT o.object_id, s.name AS schema_name, o.name AS object_name, RTRIM(o.type) AS type, ${OBJECT_TYPE_LABEL} AS type_label
     FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id
     WHERE o.name = @name AND (@schema IS NULL OR s.name = @schema) AND o.type IN (${typeList})
     ORDER BY s.name;`,
    { name, schema: schemaName },
  );

  if (matches.length === 1) return matches[0];

  const label = schemaName ? `${schemaName}.${name}` : name;
  if (matches.length > 1) {
    const list = matches.map((m) => `${m.schema_name}.${m.object_name}`).join(", ");
    throw new UserError(`Plusieurs ${kindLabel}s nommé(e)s "${name}" dans "${database}" : ${list}. Précisez le schéma.`);
  }

  const [similar] = await db.metadata<{ full_name: string }>(
    database,
    `SELECT TOP (10) s.name + '.' + o.name AS full_name
     FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id
     WHERE o.name LIKE @pattern AND o.type IN (${typeList}) AND o.is_ms_shipped = 0
     ORDER BY o.name;`,
    { pattern: `%${name}%` },
  );
  const hint = similar.length > 0 ? ` Objets proches : ${similar.map((s) => s.full_name).join(", ")}.` : "";
  throw new UserError(
    `Aucun(e) ${kindLabel} "${label}" trouvé(e) dans la base "${database}" (ou droits insuffisants pour le voir).${hint}`,
  );
}

// ---------------------------------------------------------------------------
// Enregistrement des outils
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer, db: Database, config: AppConfig): void {
  const databaseArg = z
    .string()
    .min(1)
    .max(128)
    .describe("Nom de la base de données (voir list_databases).");
  const readOnlyAnnotations = { readOnlyHint: true, openWorldHint: false } as const;

  // --- get_server_info -------------------------------------------------------
  server.registerTool(
    "get_server_info",
    {
      title: "Informations serveur",
      description:
        "Renvoie la version et l'édition de SQL Server, le compte de connexion utilisé et la configuration du serveur MCP (lecture seule, limites).",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    () =>
      run(async () => {
        const [[info]] = await db.metadata<Row>(
          db.defaultDatabase,
          `SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(256)) AS server_name,
                  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS product_version,
                  CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128)) AS product_level,
                  CAST(SERVERPROPERTY('Edition') AS nvarchar(256)) AS edition,
                  CAST(SERVERPROPERTY('EngineEdition') AS int) AS engine_edition,
                  CAST(SERVERPROPERTY('Collation') AS nvarchar(256)) AS server_collation,
                  SUSER_SNAME() AS login_name,
                  IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin,
                  @@VERSION AS version_string;`,
        );
        const engine: Record<number, string> = {
          1: "Personal/Desktop",
          2: "Standard",
          3: "Enterprise",
          4: "Express",
          5: "Azure SQL Database",
          6: "Azure Synapse",
          8: "Azure SQL Managed Instance",
          9: "Azure SQL Edge",
          11: "Azure Synapse serverless",
          12: "Microsoft Fabric",
        };
        const lines = [
          `## Serveur ${info.server_name ?? config.server}`,
          `- Version : ${info.product_version} (${info.product_level}) — ${info.edition}`,
          `- Moteur : ${engine[Number(info.engine_edition)] ?? info.engine_edition}`,
          `- Collation serveur : ${info.server_collation}`,
          `- Compte connecté : ${info.login_name}${info.is_sysadmin === 1 ? " (⚠️ membre de sysadmin)" : ""}`,
          "",
          "## Configuration du serveur MCP",
          `- Mode : ${config.readOnly ? "LECTURE SEULE (les requêtes d'écriture sont refusées et toute requête est annulée par ROLLBACK)" : "LECTURE/ÉCRITURE"}`,
          `- Lignes renvoyées par défaut / maximum : ${config.defaultRows} / ${config.maxRows}`,
          `- Délai max d'une requête : ${config.queryTimeoutMs / 1000} s`,
          `- Bases système visibles : ${config.includeSystemDatabases ? "oui" : "non"}`,
        ];
        if (config.allowedDatabases.size > 0) lines.push(`- Liste blanche : ${[...config.allowedDatabases].join(", ")}`);
        if (config.excludedDatabases.size > 0) lines.push(`- Bases exclues : ${[...config.excludedDatabases].join(", ")}`);
        lines.push("", "```", String(info.version_string ?? "").trim(), "```");
        return lines.join("\n");
      }),
  );

  // --- list_databases --------------------------------------------------------
  server.registerTool(
    "list_databases",
    {
      title: "Lister les bases de données",
      description:
        "Liste toutes les bases de données en ligne auxquelles le compte SQL configuré a accès. À appeler en premier pour savoir quelles bases interroger.",
      inputSchema: {},
      annotations: readOnlyAnnotations,
    },
    () =>
      run(async () => {
        const rows = await listAccessibleDatabases(db, config);
        if (rows.length === 0) {
          return "Aucune base accessible pour ce compte (ou toutes sont filtrées par la configuration : MSSQL_DATABASES, MSSQL_EXCLUDED_DATABASES, MSSQL_INCLUDE_SYSTEM_DATABASES).";
        }
        return [
          `${rows.length} base(s) accessible(s) :`,
          "",
          objectsTable(rows as unknown as Row[], [
            "name",
            "state_desc",
            "recovery_model_desc",
            "compatibility_level",
            "collation_name",
            "is_read_only",
            "create_date",
          ]),
        ].join("\n");
      }),
  );

  // --- list_tables -----------------------------------------------------------
  server.registerTool(
    "list_tables",
    {
      title: "Lister les tables et vues",
      description:
        "Liste les tables (et vues) d'une base avec leur schéma, un nombre de lignes approximatif et leur description (MS_Description).",
      inputSchema: {
        database: databaseArg,
        schema: z.string().max(128).optional().describe("Filtrer sur un schéma (ex. dbo)."),
        name_pattern: z
          .string()
          .max(256)
          .optional()
          .describe("Filtre sur le nom (motif LIKE ; sans % le texte est recherché n'importe où dans le nom)."),
        include_views: z.boolean().default(true).describe("Inclure les vues (true par défaut)."),
        limit: z.number().int().min(1).max(5000).default(500).describe("Nombre maximal d'objets renvoyés."),
      },
      annotations: readOnlyAnnotations,
    },
    ({ database, schema, name_pattern, include_views, limit }) =>
      run(async () => {
        assertDatabase(config, database);
        const [rows] = await db.metadata<Row>(
          database,
          `SELECT TOP (@limit + 1) s.name AS [schema], o.name AS name,
                  CASE RTRIM(o.type) WHEN 'U' THEN 'TABLE' ELSE 'VIEW' END AS type,
                  (SELECT SUM(p.rows) FROM sys.partitions AS p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS approx_rows,
                  CAST(ep.value AS nvarchar(4000)) AS description
           FROM sys.objects AS o
           JOIN sys.schemas AS s ON s.schema_id = o.schema_id
           LEFT JOIN sys.extended_properties AS ep
             ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
           WHERE o.is_ms_shipped = 0
             AND (o.type = 'U' OR (@includeViews = 1 AND o.type = 'V'))
             AND (@schema IS NULL OR s.name = @schema)
             AND (@pattern IS NULL OR o.name LIKE @pattern)
           ORDER BY s.name, o.name;`,
          {
            limit,
            includeViews: include_views,
            schema: schema?.trim() || null,
            pattern: likePattern(name_pattern),
          },
        );
        if (rows.length === 0) return `Aucune table${include_views ? " ni vue" : ""} trouvée dans "${database}" avec ces critères.`;
        const truncated = rows.length > limit;
        const shown = truncated ? rows.slice(0, limit) : rows;
        return [
          `Base "${database}" : ${shown.length} objet(s)${truncated ? ` (liste tronquée à ${limit} — affinez avec schema ou name_pattern)` : ""}.`,
          "",
          objectsTable(shown, ["schema", "name", "type", "approx_rows", "description"]),
        ].join("\n");
      }),
  );

  // --- describe_table --------------------------------------------------------
  server.registerTool(
    "describe_table",
    {
      title: "Décrire une table ou une vue",
      description:
        "Décrit la structure d'une table ou d'une vue : colonnes (types, nullabilité, défauts, descriptions), clé primaire, index, clés étrangères sortantes et entrantes, contraintes CHECK.",
      inputSchema: {
        database: databaseArg,
        table: z.string().min(1).max(300).describe('Nom de la table ou vue, éventuellement qualifié ("dbo.Clients").'),
        schema: z.string().max(128).optional().describe("Schéma, si non inclus dans le nom."),
      },
      annotations: readOnlyAnnotations,
    },
    ({ database, table, schema }) =>
      run(async () => {
        assertDatabase(config, database);
        const obj = await resolveObject(db, database, table, schema, ["U", "V"], "table ou vue");
        const [info, columns, indexes, fksOut, fksIn, checks] = await db.metadata<Row>(
          database,
          `SELECT o.create_date, o.modify_date,
                  (SELECT SUM(p.rows) FROM sys.partitions AS p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS approx_rows,
                  CAST(ep.value AS nvarchar(4000)) AS description
           FROM sys.objects AS o
           LEFT JOIN sys.extended_properties AS ep
             ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
           WHERE o.object_id = @id;

           SELECT c.column_id, c.name, TYPE_NAME(c.user_type_id) AS type_name, c.max_length, c.precision, c.scale,
                  c.is_nullable, c.is_identity, c.is_computed, c.collation_name,
                  dc.definition AS default_value, cc.definition AS computed_definition,
                  CAST(ep.value AS nvarchar(4000)) AS description,
                  CASE WHEN EXISTS (
                    SELECT 1 FROM sys.indexes AS i
                    JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                    WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
                  ) THEN 1 ELSE 0 END AS is_pk
           FROM sys.columns AS c
           LEFT JOIN sys.default_constraints AS dc ON dc.object_id = c.default_object_id
           LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
           LEFT JOIN sys.extended_properties AS ep
             ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
           WHERE c.object_id = @id
           ORDER BY c.column_id;

           SELECT i.name, i.type_desc, i.is_primary_key, i.is_unique, i.filter_definition,
                  STUFF((SELECT ', ' + col.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
                         FROM sys.index_columns AS ic
                         JOIN sys.columns AS col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
                         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
                         ORDER BY ic.key_ordinal
                         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS key_columns,
                  STUFF((SELECT ', ' + col.name
                         FROM sys.index_columns AS ic
                         JOIN sys.columns AS col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
                         WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
                         ORDER BY col.name
                         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS included_columns
           FROM sys.indexes AS i
           WHERE i.object_id = @id AND i.type > 0
           ORDER BY i.is_primary_key DESC, i.name;

           SELECT fk.name,
                  STUFF((SELECT ', ' + pc.name FROM sys.foreign_key_columns AS fkc
                         JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                         WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id
                         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS columns,
                  OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS referenced_table,
                  STUFF((SELECT ', ' + rc.name FROM sys.foreign_key_columns AS fkc
                         JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                         WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id
                         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS referenced_columns,
                  fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update,
                  fk.is_disabled
           FROM sys.foreign_keys AS fk
           WHERE fk.parent_object_id = @id
           ORDER BY fk.name;

           SELECT fk.name,
                  OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS referencing_table,
                  STUFF((SELECT ', ' + pc.name FROM sys.foreign_key_columns AS fkc
                         JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
                         WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id
                         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS referencing_columns,
                  STUFF((SELECT ', ' + rc.name FROM sys.foreign_key_columns AS fkc
                         JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
                         WHERE fkc.constraint_object_id = fk.object_id ORDER BY fkc.constraint_column_id
                         FOR XML PATH(''), TYPE).value('.', 'nvarchar(max)'), 1, 2, '') AS referenced_columns
           FROM sys.foreign_keys AS fk
           WHERE fk.referenced_object_id = @id
           ORDER BY referencing_table, fk.name;

           SELECT cc.name, cc.definition, cc.is_disabled
           FROM sys.check_constraints AS cc
           WHERE cc.parent_object_id = @id
           ORDER BY cc.name;`,
          { id: obj.object_id },
        );

        const meta = info[0] ?? {};
        const out: string[] = [
          `## ${obj.type_label === "TABLE" ? "Table" : "Vue"} ${obj.schema_name}.${obj.object_name} (base ${database})`,
        ];
        const facts: string[] = [];
        if (meta.approx_rows !== null && meta.approx_rows !== undefined) facts.push(`~${meta.approx_rows} lignes`);
        facts.push(`${columns.length} colonnes`);
        out.push(facts.join(" · "));
        if (meta.description) out.push(`Description : ${meta.description}`);

        out.push("", "### Colonnes");
        out.push(
          objectsTable(
            columns.map((c) => {
              const attrs: string[] = [];
              if (c.is_pk) attrs.push("PK");
              if (c.is_identity) attrs.push("IDENTITY");
              if (c.is_computed) attrs.push(`CALCULÉE ${c.computed_definition ?? ""}`.trim());
              return {
                "#": c.column_id,
                colonne: c.name,
                type: formatSqlType(
                  String(c.type_name),
                  c.max_length as number,
                  c.precision as number,
                  c.scale as number,
                ),
                null: c.is_nullable ? "oui" : "non",
                attributs: attrs.join(", "),
                "défaut": c.default_value,
                description: c.description,
              };
            }),
            ["#", "colonne", "type", "null", "attributs", "défaut", "description"],
          ),
        );

        if (indexes.length > 0) {
          out.push("", "### Clé primaire et index");
          out.push(
            objectsTable(
              indexes.map((i) => ({
                index: i.name,
                type: `${i.is_primary_key ? "PRIMARY KEY " : ""}${i.is_unique && !i.is_primary_key ? "UNIQUE " : ""}${i.type_desc}`,
                colonnes: i.key_columns,
                incluses: i.included_columns,
                filtre: i.filter_definition,
              })),
              ["index", "type", "colonnes", "incluses", "filtre"],
            ),
          );
        }

        if (fksOut.length > 0) {
          out.push("", "### Clés étrangères (cette table référence)");
          out.push(
            objectsTable(
              fksOut.map((f) => ({ ...f, name: `${f.name}${f.is_disabled ? " (désactivée)" : ""}` })),
              ["name", "columns", "referenced_table", "referenced_columns", "on_delete", "on_update"],
            ),
          );
        }

        if (fksIn.length > 0) {
          out.push("", "### Référencée par (clés étrangères entrantes)");
          out.push(objectsTable(fksIn, ["name", "referencing_table", "referencing_columns", "referenced_columns"]));
        }

        if (checks.length > 0) {
          out.push("", "### Contraintes CHECK");
          out.push(
            objectsTable(
              checks.map((c) => ({ ...c, name: `${c.name}${c.is_disabled ? " (désactivée)" : ""}` })),
              ["name", "definition"],
            ),
          );
        }

        if (obj.type === "V") {
          out.push("", `_Pour le code SQL de la vue : get_object_definition("${database}", "${obj.schema_name}.${obj.object_name}")._`);
        }
        return out.join("\n");
      }),
  );

  // --- list_routines ---------------------------------------------------------
  const routineTypes = {
    procedure: ["P", "PC"],
    function: ["FN", "IF", "TF", "FS", "FT"],
    trigger: ["TR"],
  } as const;

  server.registerTool(
    "list_routines",
    {
      title: "Lister procédures, fonctions et triggers",
      description: "Liste les procédures stockées, fonctions et triggers d'une base.",
      inputSchema: {
        database: databaseArg,
        kind: z
          .enum(["all", "procedure", "function", "trigger"])
          .default("all")
          .describe("Type d'objet à lister."),
        schema: z.string().max(128).optional().describe("Filtrer sur un schéma."),
        name_pattern: z.string().max(256).optional().describe("Filtre sur le nom (motif LIKE)."),
        limit: z.number().int().min(1).max(5000).default(500),
      },
      annotations: readOnlyAnnotations,
    },
    ({ database, kind, schema, name_pattern, limit }) =>
      run(async () => {
        assertDatabase(config, database);
        const types: readonly string[] =
          kind === "all" ? [...routineTypes.procedure, ...routineTypes.function, ...routineTypes.trigger] : routineTypes[kind];
        const [rows] = await db.metadata<Row>(
          database,
          `SELECT TOP (@limit + 1) s.name AS [schema], o.name AS name, ${OBJECT_TYPE_LABEL} AS type,
                  CASE WHEN o.parent_object_id <> 0 THEN OBJECT_SCHEMA_NAME(o.parent_object_id) + '.' + OBJECT_NAME(o.parent_object_id) END AS parent,
                  CONVERT(varchar(19), o.modify_date, 120) AS modified,
                  CAST(ep.value AS nvarchar(4000)) AS description
           FROM sys.objects AS o
           JOIN sys.schemas AS s ON s.schema_id = o.schema_id
           LEFT JOIN sys.extended_properties AS ep
             ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
           WHERE o.is_ms_shipped = 0 AND o.type IN (${types.map((t) => `'${t}'`).join(", ")})
             AND (@schema IS NULL OR s.name = @schema)
             AND (@pattern IS NULL OR o.name LIKE @pattern)
           ORDER BY 3, 1, 2;`,
          { limit, schema: schema?.trim() || null, pattern: likePattern(name_pattern) },
        );
        if (rows.length === 0) return `Aucun objet de ce type trouvé dans "${database}".`;
        const truncated = rows.length > limit;
        const shown = truncated ? rows.slice(0, limit) : rows;
        return [
          `Base "${database}" : ${shown.length} objet(s)${truncated ? ` (tronqué à ${limit})` : ""}.`,
          "",
          objectsTable(shown, ["schema", "name", "type", "parent", "modified", "description"]),
        ].join("\n");
      }),
  );

  // --- get_object_definition -------------------------------------------------
  server.registerTool(
    "get_object_definition",
    {
      title: "Code SQL d'un objet",
      description:
        "Renvoie le code source T-SQL d'une vue, procédure stockée, fonction ou trigger, ainsi que ses paramètres.",
      inputSchema: {
        database: databaseArg,
        object_name: z.string().min(1).max(300).describe('Nom de l\'objet, éventuellement qualifié ("dbo.MaProcedure").'),
        schema: z.string().max(128).optional(),
      },
      annotations: readOnlyAnnotations,
    },
    ({ database, object_name, schema }) =>
      run(async () => {
        assertDatabase(config, database);
        const obj = await resolveObject(
          db,
          database,
          object_name,
          schema,
          ["V", "P", "FN", "IF", "TF", "TR"],
          "vue, procédure, fonction ou trigger",
        );
        const [[def], params] = await db.metadata<Row>(
          database,
          `SELECT OBJECT_DEFINITION(@id) AS definition;
           SELECT p.parameter_id, p.name, TYPE_NAME(p.user_type_id) AS type_name, p.max_length, p.precision, p.scale,
                  p.is_output, p.has_default_value, p.is_readonly
           FROM sys.parameters AS p WHERE p.object_id = @id ORDER BY p.parameter_id;`,
          { id: obj.object_id },
        );

        const out = [`## ${obj.type_label} ${obj.schema_name}.${obj.object_name} (base ${database})`];
        if (params.length > 0) {
          out.push("", "### Paramètres");
          out.push(
            objectsTable(
              params.map((p) => ({
                "paramètre": p.parameter_id === 0 ? "(valeur de retour)" : p.name,
                type: formatSqlType(String(p.type_name), p.max_length as number, p.precision as number, p.scale as number),
                options: [p.is_output && p.parameter_id !== 0 ? "OUTPUT" : "", p.is_readonly ? "READONLY" : ""]
                  .filter(Boolean)
                  .join(", "),
              })),
              ["paramètre", "type", "options"],
            ),
          );
        }
        out.push("", "### Définition");
        if (def?.definition) {
          out.push("```sql", String(def.definition).trim(), "```");
        } else {
          out.push(
            "_Définition indisponible : objet chiffré (WITH ENCRYPTION), objet CLR, ou droit VIEW DEFINITION manquant pour ce compte._",
          );
        }
        return out.join("\n");
      }),
  );

  // --- search_schema ---------------------------------------------------------
  server.registerTool(
    "search_schema",
    {
      title: "Rechercher dans les schémas",
      description:
        "Recherche des tables, vues, routines et colonnes dont le nom contient un texte, dans une base ou dans TOUTES les bases accessibles (si database est omis). Peut aussi chercher dans le code des vues/procédures/fonctions.",
      inputSchema: {
        pattern: z.string().min(1).max(256).describe("Texte recherché (motif LIKE ; sans % il est cherché n'importe où)."),
        database: databaseArg.optional().describe("Base à fouiller. Omis = toutes les bases accessibles."),
        search_definitions: z
          .boolean()
          .default(false)
          .describe("Chercher aussi dans le code source des vues, procédures, fonctions et triggers."),
        limit: z.number().int().min(1).max(2000).default(200).describe("Nombre maximal de résultats (au total)."),
      },
      annotations: readOnlyAnnotations,
    },
    ({ pattern, database, search_definitions, limit }) =>
      run(async () => {
        let databases: string[];
        if (database) {
          assertDatabase(config, database);
          databases = [database];
        } else {
          databases = (await listAccessibleDatabases(db, config)).map((d) => d.name);
        }

        const query = `
          SELECT TOP (@limit) * FROM (
            SELECT s.name AS [schema], o.name AS [object], ${OBJECT_TYPE_LABEL} AS [type],
                   CAST(NULL AS sysname) AS [column], CAST(NULL AS nvarchar(300)) AS [column_type], 'nom d''objet' AS [match]
            FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id
            WHERE o.is_ms_shipped = 0 AND o.type IN ('U','V','P','FN','IF','TF','TR','SN') AND o.name LIKE @pattern
            UNION ALL
            SELECT s.name, o.name, ${OBJECT_TYPE_LABEL}, c.name, TYPE_NAME(c.user_type_id), 'nom de colonne'
            FROM sys.columns AS c
            JOIN sys.objects AS o ON o.object_id = c.object_id
            JOIN sys.schemas AS s ON s.schema_id = o.schema_id
            WHERE o.is_ms_shipped = 0 AND o.type IN ('U','V') AND c.name LIKE @pattern
            ${
              search_definitions
                ? `UNION ALL
            SELECT s.name, o.name, ${OBJECT_TYPE_LABEL}, NULL, NULL, 'code source'
            FROM sys.sql_modules AS m
            JOIN sys.objects AS o ON o.object_id = m.object_id
            JOIN sys.schemas AS s ON s.schema_id = o.schema_id
            WHERE o.is_ms_shipped = 0 AND m.definition LIKE @pattern`
                : ""
            }
          ) AS x
          ORDER BY [match], [schema], [object], [column];`;

        const like = likePattern(pattern);
        const perDb = await mapLimit(databases, 4, async (name) => {
          try {
            const [rows] = await db.metadata<Row>(name, query, { limit, pattern: like });
            return { name, rows, error: undefined as string | undefined };
          } catch (err) {
            return { name, rows: [] as Row[], error: describeError(err) };
          }
        });

        const all: Row[] = [];
        for (const r of perDb) for (const row of r.rows) all.push({ database: r.name, ...row });
        const truncated = all.length > limit;
        const shown = all.slice(0, limit);
        const failures = perDb.filter((r) => r.error);

        const out = [
          `Recherche "${pattern}" dans ${databases.length} base(s) : ${shown.length} résultat(s)${truncated ? ` (tronqué à ${limit})` : ""}.`,
        ];
        if (shown.length > 0) {
          out.push("", objectsTable(shown, ["database", "schema", "object", "type", "column", "column_type", "match"]));
        }
        if (failures.length > 0) {
          out.push("", "Bases non fouillées (erreur) :", ...failures.map((f) => `- ${f.name} : ${f.error}`));
        }
        return out.join("\n");
      }),
  );

  // --- execute_query ---------------------------------------------------------
  server.registerTool(
    "execute_query",
    {
      title: "Exécuter une requête SQL",
      description: config.readOnly
        ? `Exécute une requête T-SQL de LECTURE (SELECT, WITH ... SELECT, DECLARE/SET de variables) dans une base et renvoie les résultats sous forme de tableau. Les instructions d'écriture, DDL et EXEC sont refusées ; la requête tourne dans une transaction annulée. Syntaxe SQL Server : utilisez TOP (n) ou OFFSET/FETCH, pas LIMIT. Résultats limités à ${config.defaultRows} lignes par défaut (max ${config.maxRows}).`
        : `Exécute une requête T-SQL (lecture ou écriture) dans une base et renvoie les résultats. ATTENTION : le serveur est en mode lecture/écriture, les modifications sont validées. Syntaxe SQL Server : TOP (n) ou OFFSET/FETCH, pas LIMIT. Résultats limités à ${config.defaultRows} lignes par défaut (max ${config.maxRows}).`,
      inputSchema: {
        database: databaseArg,
        query: z.string().min(1).max(100_000).describe("Requête T-SQL à exécuter."),
        max_rows: z
          .number()
          .int()
          .min(1)
          .max(config.maxRows)
          .optional()
          .describe(`Nombre maximal de lignes renvoyées par jeu de résultats (défaut ${config.defaultRows}, max ${config.maxRows}).`),
      },
      annotations: config.readOnly
        ? { readOnlyHint: true, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ database, query, max_rows }) =>
      run(async () => {
        assertDatabase(config, database);
        if (config.readOnly) assertReadOnlyQuery(query);
        const maxRows = max_rows ?? config.defaultRows;

        const outcome = await db.execute(database, query, { maxRows, readOnly: config.readOnly });

        const header = `Base "${database}" · ${outcome.durationMs} ms${config.readOnly ? " · lecture seule" : ""}`;
        const out: string[] = [header];
        let budget = MAX_OUTPUT_CHARS;
        let budgetExceeded = false;

        outcome.resultSets.forEach((rs, index) => {
          const title =
            outcome.resultSets.length > 1 ? `### Résultat ${index + 1}` : "### Résultat";
          out.push("", title);
          if (rs.columns.length === 0) {
            out.push("_(aucune colonne)_");
            return;
          }
          const headerLine = markdownHeader(rs.columns.map((c) => c.name));
          const types = rs.columns.map((c) => c.type);
          const lines: string[] = [headerLine];
          budget -= headerLine.length;
          let written = 0;
          for (const row of rs.rows) {
            const line = markdownRow(row, config.maxCellLength, types);
            if (budget - line.length < 0) {
              budgetExceeded = true;
              break;
            }
            budget -= line.length + 1;
            lines.push(line);
            written++;
          }
          out.push(lines.join("\n"));

          const notes: string[] = [`${written} ligne(s) affichée(s)`];
          if (rs.truncated) notes.push(`d'autres lignes existent (limite de ${maxRows} atteinte : ajoutez un filtre, un TOP, ou augmentez max_rows)`);
          if (written < rs.rows.length) notes.push(`${rs.rows.length - written} ligne(s) lue(s) mais non affichée(s) : réponse trop volumineuse, sélectionnez moins de colonnes ou de lignes`);
          out.push(`_${notes.join(" ; ")}._`);
        });

        if (outcome.resultSets.length === 0) {
          const affected = outcome.rowsAffected.reduce((a, b) => a + b, 0);
          out.push(
            "",
            config.readOnly
              ? "Requête exécutée, aucun jeu de résultats renvoyé."
              : `Requête exécutée. Lignes affectées : ${affected}.`,
          );
        } else if (!config.readOnly && outcome.rowsAffected.length > 0) {
          out.push("", `Lignes affectées (par instruction) : ${outcome.rowsAffected.join(", ")}.`);
        }

        if (outcome.stoppedEarly) {
          out.push("", "_Exécution interrompue à la limite de lignes : les éventuels jeux de résultats suivants n'ont pas été lus._");
        }
        if (budgetExceeded) {
          out.push("", "_Réponse tronquée pour rester lisible._");
        }
        return out.join("\n");
      }),
  );
}
