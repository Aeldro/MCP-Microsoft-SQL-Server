/**
 * Garde-fou "lecture seule" pour les requêtes T-SQL soumises par le modèle.
 *
 * C'est une protection de confort, PAS une frontière de sécurité : la vraie
 * protection reste les droits du compte SQL (ex. rôle db_datareader uniquement).
 * En complément, execute_query exécute la requête dans une transaction qui est
 * toujours annulée (ROLLBACK) en mode lecture seule.
 */

/** Mots-clés interdits n'importe où dans la requête (hors commentaires, chaînes et identifiants délimités). */
const FORBIDDEN_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE",
  "CREATE", "ALTER", "DROP",
  "GRANT", "REVOKE", "DENY",
  "EXEC", "EXECUTE",
  "BACKUP", "RESTORE", "DBCC", "CHECKPOINT", "KILL", "SHUTDOWN", "RECONFIGURE",
  "BULK", "OPENROWSET", "OPENDATASOURCE", "OPENQUERY",
  "WRITETEXT", "UPDATETEXT",
  "USE", "SETUSER", "REVERT",
  "COMMIT", "ROLLBACK", "SAVE",
  "TRIGGER",
  "SEND", "RECEIVE",
]);

/** Interdits sauf juste après SET (pour autoriser "SET TRANSACTION ISOLATION LEVEL ..."). */
const FORBIDDEN_UNLESS_AFTER_SET = new Set(["TRAN", "TRANSACTION"]);

/** Mots-clés autorisés comme premier mot du lot (évite l'exécution implicite d'une procédure). */
const ALLOWED_FIRST_KEYWORDS = new Set(["SELECT", "WITH", "DECLARE", "SET", "IF", "BEGIN", "PRINT"]);

export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyViolation";
  }
}

/**
 * Remplace commentaires, chaînes littérales et identifiants délimités ([..] et "..")
 * par des jetons neutres, pour que l'analyse ne porte que sur le code SQL réel.
 */
export function maskSql(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // Commentaire ligne
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }

    // Commentaire bloc (imbricable en T-SQL)
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out += " ";
      continue;
    }

    // Chaîne littérale '...' ('' = apostrophe échappée)
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " __STR__ ";
      continue;
    }

    // Identifiant délimité [..] (]] = crochet échappé) ou "..."
    if (c === "[" || c === '"') {
      const close = c === "[" ? "]" : '"';
      i++;
      while (i < n) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " __IDENT__ ";
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

function tokenize(masked: string): string[] {
  return masked.match(/[A-Za-z_@#][A-Za-z0-9_@#$]*|[^\sA-Za-z0-9_@#$]/g) ?? [];
}

/**
 * Lève une ReadOnlyViolation si la requête semble pouvoir modifier des données,
 * le schéma, les droits ou l'état du serveur.
 */
export function assertReadOnlyQuery(sql: string): void {
  const tokens = tokenize(maskSql(sql));
  const words = tokens.map((t) => t.toUpperCase());

  const firstIndex = words.findIndex((w) => w !== ";" && w !== "(");
  if (firstIndex === -1) {
    throw new ReadOnlyViolation("La requête est vide.");
  }
  const first = words[firstIndex];
  if (!ALLOWED_FIRST_KEYWORDS.has(first)) {
    throw new ReadOnlyViolation(
      `En mode lecture seule, une requête doit commencer par SELECT, WITH, DECLARE, SET, IF, BEGIN ou PRINT (trouvé : "${tokens[firstIndex]}").`,
    );
  }

  for (let k = 0; k < words.length; k++) {
    const word = words[k];

    if (FORBIDDEN_KEYWORDS.has(word)) {
      throw new ReadOnlyViolation(
        `Mot-clé "${word}" interdit en mode lecture seule. Seules les requêtes de lecture (SELECT) sont autorisées.`,
      );
    }

    if (FORBIDDEN_UNLESS_AFTER_SET.has(word) && words[k - 1] !== "SET") {
      throw new ReadOnlyViolation(
        `Mot-clé "${word}" interdit en mode lecture seule : la gestion des transactions est faite par le serveur MCP.`,
      );
    }

    // SELECT ... INTO : seulement vers une table temporaire (#tmp).
    if (word === "INTO") {
      const target = tokens[k + 1] ?? "";
      if (!target.startsWith("#")) {
        throw new ReadOnlyViolation(
          'SELECT ... INTO n\'est autorisé que vers une table temporaire (ex. "INTO #resultat") en mode lecture seule.',
        );
      }
    }
  }
}
