/**
 * Lecture et validation de la configuration (variables d'environnement).
 *
 * Toutes les variables sont préfixées par MSSQL_. Elles sont fournies par le
 * client MCP (bloc "env" de claude_desktop_config.json / .mcp.json) ou par un
 * fichier .env chargé via `node --env-file=...`.
 */

export interface AppConfig {
  server: string;
  port?: number;
  instanceName?: string;
  user: string;
  password: string;
  /** Base utilisée pour les requêtes de niveau serveur (liste des bases, infos serveur). */
  defaultDatabase: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
  readOnly: boolean;
  /** Nombre maximal de lignes qu'execute_query peut renvoyer. */
  maxRows: number;
  /** Nombre de lignes renvoyées par défaut par execute_query. */
  defaultRows: number;
  /** Longueur maximale d'une cellule dans les résultats (au-delà : tronquée). */
  maxCellLength: number;
  includeSystemDatabases: boolean;
  /** Liste blanche (noms en minuscules). Vide = toutes les bases accessibles. */
  allowedDatabases: Set<string>;
  /** Liste noire (noms en minuscules). */
  excludedDatabases: Set<string>;
}

export const SYSTEM_DATABASES = new Set(["master", "tempdb", "model", "msdb"]);

function env(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function required(name: string): string {
  const value = env(name);
  if (value === undefined) {
    throw new Error(`La variable d'environnement ${name} est obligatoire.`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  const v = value.toLowerCase();
  if (["1", "true", "yes", "y", "oui", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "non", "off"].includes(v)) return false;
  throw new Error(`${name} doit être un booléen (true/false), reçu : "${value}".`);
}

function int(name: string, fallback: number, min: number, max: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} doit être un entier entre ${min} et ${max}, reçu : "${value}".`);
  }
  return n;
}

function nameList(name: string): Set<string> {
  const value = env(name);
  if (value === undefined) return new Set();
  return new Set(
    value
      .split(/[,;]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/**
 * Accepte les formes "hote", "hote,port", "hote:port" et "hote\instance".
 */
function parseServer(raw: string): { host: string; port?: number; instance?: string } {
  let host = raw.replace(/^tcp:/i, "");
  let port: number | undefined;
  let instance: string | undefined;

  const backslash = host.indexOf("\\");
  if (backslash >= 0) {
    instance = host.slice(backslash + 1);
    host = host.slice(0, backslash);
  }

  const portMatch = /^(.*?)[,:](\d+)$/.exec(host);
  if (portMatch) {
    host = portMatch[1];
    port = Number(portMatch[2]);
  }

  return { host, port, instance };
}

export function loadConfig(): AppConfig {
  const parsed = parseServer(required("MSSQL_SERVER"));
  const instanceName = env("MSSQL_INSTANCE") ?? parsed.instance;
  const explicitPort = env("MSSQL_PORT") !== undefined ? int("MSSQL_PORT", 1433, 1, 65535) : undefined;
  // Avec une instance nommée, le port est découvert via SQL Browser sauf s'il est forcé.
  const port = explicitPort ?? parsed.port ?? (instanceName ? undefined : 1433);

  const maxRows = int("MSSQL_MAX_ROWS", 1000, 1, 100000);
  const defaultRows = Math.min(int("MSSQL_DEFAULT_ROWS", 100, 1, 100000), maxRows);

  return {
    server: parsed.host,
    port,
    instanceName: port === undefined ? instanceName : undefined,
    user: required("MSSQL_USER"),
    password: required("MSSQL_PASSWORD"),
    defaultDatabase: env("MSSQL_DEFAULT_DATABASE") ?? "master",
    encrypt: bool("MSSQL_ENCRYPT", true),
    trustServerCertificate: bool("MSSQL_TRUST_SERVER_CERTIFICATE", false),
    connectTimeoutMs: int("MSSQL_CONNECT_TIMEOUT_MS", 15000, 1000, 600000),
    queryTimeoutMs: int("MSSQL_QUERY_TIMEOUT_MS", 60000, 1000, 3600000),
    readOnly: bool("MSSQL_READONLY", true),
    maxRows,
    defaultRows,
    maxCellLength: int("MSSQL_MAX_CELL_LENGTH", 1000, 20, 1000000),
    includeSystemDatabases: bool("MSSQL_INCLUDE_SYSTEM_DATABASES", false),
    allowedDatabases: nameList("MSSQL_DATABASES"),
    excludedDatabases: nameList("MSSQL_EXCLUDED_DATABASES"),
  };
}

/** Indique si une base est visible/utilisable selon la configuration locale. */
export function isDatabaseAllowedByConfig(config: AppConfig, database: string): boolean {
  const name = database.toLowerCase();
  if (!config.includeSystemDatabases && SYSTEM_DATABASES.has(name)) return false;
  if (config.excludedDatabases.has(name)) return false;
  if (config.allowedDatabases.size > 0 && !config.allowedDatabases.has(name)) return false;
  return true;
}
