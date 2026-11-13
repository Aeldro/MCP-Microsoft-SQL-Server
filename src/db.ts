/**
 * Gestion des connexions SQL Server.
 *
 * - Un pool de connexions par base, créé à la demande, pour les requêtes de
 *   métadonnées (écrites par ce serveur, paramétrées).
 * - Une connexion dédiée et éphémère pour chaque appel à execute_query : l'état
 *   de session (SET, tables #temp...) ne fuit jamais d'une requête à l'autre.
 *
 * Se connecter directement à chaque base (plutôt que d'utiliser "USE") fonctionne
 * aussi avec Azure SQL Database, où USE n'est pas supporté.
 */
import sql from "mssql";
import type { AppConfig } from "./config.js";

export interface ColumnInfo {
  name: string;
  type: string;
}

export interface ResultSet {
  columns: ColumnInfo[];
  rows: unknown[][];
  /** Vrai si des lignes supplémentaires existaient mais n'ont pas été lues. */
  truncated: boolean;
}

export interface QueryOutcome {
  resultSets: ResultSet[];
  rowsAffected: number[];
  /** Vrai si l'exécution a été interrompue après avoir atteint la limite de lignes. */
  stoppedEarly: boolean;
  durationMs: number;
}

export class Database {
  private readonly pools = new Map<string, Promise<sql.ConnectionPool>>();

  constructor(private readonly config: AppConfig) {}

  get defaultDatabase(): string {
    return this.config.defaultDatabase;
  }

  private baseConfig(database: string): sql.config {
    const c = this.config;
    return {
      server: c.server,
      port: c.port,
      user: c.user,
      password: c.password,
      database,
      connectionTimeout: c.connectTimeoutMs,
      requestTimeout: c.queryTimeoutMs,
      options: {
        encrypt: c.encrypt,
        trustServerCertificate: c.trustServerCertificate,
        instanceName: c.instanceName,
        appName: "mcp-sqlserver",
        enableArithAbort: true,
      },
    };
  }

  /** Pool partagé (métadonnées) pour une base donnée. */
  async pool(database: string): Promise<sql.ConnectionPool> {
    const key = database.toLowerCase();
    let pending = this.pools.get(key);
    if (!pending) {
      const pool = new sql.ConnectionPool({
        ...this.baseConfig(database),
        pool: { max: 4, min: 0, idleTimeoutMillis: 60000 },
      });
      pool.on("error", (err) => console.error(`[mssql] erreur du pool "${database}" :`, err));
      pending = pool.connect().catch((err) => {
        this.pools.delete(key);
        throw explainConnectionError(err, database);
      });
      this.pools.set(key, pending);
    }
    return pending;
  }

  /** Exécute une requête interne paramétrée et renvoie tous ses jeux de résultats. */
  async metadata<T = Record<string, unknown>>(
    database: string,
    query: string,
    params: Record<string, string | number | boolean | null> = {},
  ): Promise<T[][]> {
    const pool = await this.pool(database);
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) {
      if (typeof value === "number") request.input(name, sql.Int, value);
      else if (typeof value === "boolean") request.input(name, sql.Bit, value);
      else request.input(name, sql.NVarChar(4000), value);
    }
    const result = await request.query(query);
    return result.recordsets as unknown as T[][];
  }

  /**
   * Exécute une requête libre sur une connexion dédiée.
   * En lecture seule, la requête tourne dans une transaction systématiquement annulée.
   */
  async execute(
    database: string,
    query: string,
    options: { maxRows: number; readOnly: boolean },
  ): Promise<QueryOutcome> {
    const started = Date.now();
    const connection = new sql.ConnectionPool({
      ...this.baseConfig(database),
      pool: { max: 1, min: 0 },
    });
    connection.on("error", (err) => console.error("[mssql] erreur de connexion :", err));

    try {
      await connection.connect().catch((err) => {
        throw explainConnectionError(err, database);
      });

      let transaction: sql.Transaction | undefined;
      if (options.readOnly) {
        transaction = new sql.Transaction(connection);
        await transaction.begin();
      }

      try {
        const request = transaction ? new sql.Request(transaction) : new sql.Request(connection);
        const outcome = await streamQuery(request, query, options.maxRows);
        if (transaction) {
          await safeRollback(transaction);
        }
        return { ...outcome, durationMs: Date.now() - started };
      } catch (err) {
        if (transaction) await safeRollback(transaction);
        throw err;
      }
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  async closeAll(): Promise<void> {
    const pending = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(
      pending.map((p) =>
        p.then(
          (pool) => pool.close(),
          () => undefined,
        ),
      ),
    );
  }
}

async function safeRollback(transaction: sql.Transaction): Promise<void> {
  try {
    await transaction.rollback();
  } catch {
    // Transaction déjà annulée par le serveur (erreur, annulation...) : rien à faire.
  }
}

/**
 * Lit les résultats en flux pour ne garder que `maxRows` lignes par jeu de résultats.
 * Dès que la limite est dépassée, la requête est annulée côté serveur.
 */
function streamQuery(
  request: sql.Request,
  query: string,
  maxRows: number,
): Promise<Omit<QueryOutcome, "durationMs">> {
  return new Promise((resolve, reject) => {
    const resultSets: ResultSet[] = [];
    const rowsAffected: number[] = [];
    let current: ResultSet | undefined;
    let stoppedEarly = false;
    let error: unknown;

    request.stream = true;
    request.arrayRowMode = true;

    request.on("recordset", (columns: Array<{ name: string; type: unknown }>) => {
      current = {
        columns: columns.map((col) => ({ name: col.name || "(sans nom)", type: sqlTypeName(col.type) })),
        rows: [],
        truncated: false,
      };
      resultSets.push(current);
    });

    request.on("row", (row: unknown[]) => {
      if (!current || stoppedEarly) return;
      if (current.rows.length < maxRows) {
        current.rows.push(row);
      } else {
        current.truncated = true;
        stoppedEarly = true;
        request.cancel();
      }
    });

    request.on("rowsaffected", (count: number) => {
      rowsAffected.push(count);
    });

    request.on("error", (err: unknown) => {
      // L'annulation volontaire (limite de lignes atteinte) n'est pas une erreur.
      if (stoppedEarly && isCancelError(err)) return;
      error ??= err;
    });

    request.query(query, () => {
      if (error) reject(error);
      else resolve({ resultSets, rowsAffected, stoppedEarly });
    });
  });
}

function isCancelError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const message = String((err as { message?: string } | null)?.message ?? "");
  return code === "ECANCEL" || /cancel/i.test(message);
}

function sqlTypeName(type: unknown): string {
  if (typeof type === "function") {
    const declaration = (type as { declaration?: string }).declaration;
    return declaration ?? type.name ?? "?";
  }
  if (type && typeof type === "object") {
    const t = type as { declaration?: string; type?: { declaration?: string } };
    return t.declaration ?? t.type?.declaration ?? "?";
  }
  return "?";
}

/** Rend les erreurs de connexion plus compréhensibles (certificat, login, base inaccessible...). */
export function explainConnectionError(err: unknown, database: string): Error {
  const e = err as { message?: string; code?: string; originalError?: { message?: string } };
  const message = e?.originalError?.message ?? e?.message ?? String(err);
  const hints: string[] = [];

  if (/self[- ]signed|certificate|SSL|TLS/i.test(message)) {
    hints.push(
      "Le certificat TLS du serveur n'est pas reconnu : si c'est un certificat auto-signé, définissez MSSQL_TRUST_SERVER_CERTIFICATE=true.",
    );
  }
  if (/Login failed|Échec de l'ouverture de session/i.test(message)) {
    hints.push(
      `Identifiants refusés, ou le compte n'a pas accès à la base "${database}" (vérifiez MSSQL_USER / MSSQL_PASSWORD et les droits).`,
    );
  }
  if (/Cannot open database|Impossible d'ouvrir la base/i.test(message)) {
    hints.push(`Le compte n'a pas accès à la base "${database}" ou elle n'existe pas.`);
  }
  if (
    e?.code === "ETIMEOUT" ||
    e?.code === "ESOCKET" ||
    /timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|getaddrinfo|Failed to connect|Could not connect/i.test(message)
  ) {
    hints.push(
      "Serveur injoignable : vérifiez MSSQL_SERVER, MSSQL_PORT (1433 par défaut), le pare-feu, le VPN, et que TCP/IP est activé sur l'instance.",
    );
  }

  const full = hints.length > 0 ? `${message}\n→ ${hints.join("\n→ ")}` : message;
  return new Error(`Connexion à la base "${database}" impossible : ${full}`);
}
