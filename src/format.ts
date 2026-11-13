/**
 * Mise en forme des résultats en texte lisible par le modèle (tableaux Markdown).
 */

/**
 * Les dates SQL sans fuseau (date, datetime, datetime2, smalldatetime) sont lues en
 * UTC par le pilote (option useUTC), ce qui préserve l'heure "murale" : on l'affiche
 * donc sans suffixe Z. Seul datetimeoffset représente un instant absolu.
 */
function formatDate(value: Date, sqlType?: string): string {
  if (Number.isNaN(value.getTime())) return "Invalid Date";
  const iso = value.toISOString();
  switch ((sqlType ?? "").toLowerCase()) {
    case "date":
      return iso.slice(0, 10);
    case "time":
      return iso.slice(11, 23);
    case "datetimeoffset":
      return iso;
    default:
      return iso.replace("T", " ").replace("Z", "");
  }
}

export function formatValue(value: unknown, maxLength: number, sqlType?: string): string {
  let text: string;
  if (value === null || value === undefined) {
    text = "NULL";
  } else if (value instanceof Date) {
    text = formatDate(value, sqlType);
  } else if (Buffer.isBuffer(value)) {
    const hexLimit = Math.max(8, Math.floor(maxLength / 2));
    const hex = value.subarray(0, hexLimit).toString("hex").toUpperCase();
    text = `0x${hex}${value.length > hexLimit ? `… (${value.length} octets)` : ""}`;
  } else if (typeof value === "object") {
    text = JSON.stringify(value);
  } else {
    text = String(value);
  }

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}… [${text.length} caractères]`;
  }
  return text;
}

function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n|\r/g, "↵");
}

export function markdownHeader(headers: string[]): string {
  const head = `| ${headers.map((h) => escapeCell(h)).join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  return `${head}\n${sep}`;
}

export function markdownRow(row: unknown[], maxCellLength: number, columnTypes?: string[]): string {
  return `| ${row.map((v, i) => escapeCell(formatValue(v, maxCellLength, columnTypes?.[i]))).join(" | ")} |`;
}

export function markdownTable(headers: string[], rows: unknown[][], maxCellLength: number): string {
  if (headers.length === 0) return "_(aucune colonne)_";
  return [markdownHeader(headers), ...rows.map((row) => markdownRow(row, maxCellLength))].join("\n");
}

/** Tableau à partir d'objets (résultats de requêtes de métadonnées). */
export function objectsTable(
  rows: Record<string, unknown>[],
  columns: string[],
  maxCellLength = 4000,
): string {
  if (rows.length === 0) return "_(aucun résultat)_";
  return markdownTable(
    columns,
    rows.map((r) => columns.map((c) => r[c])),
    maxCellLength,
  );
}

/** Rend un type SQL lisible : nvarchar(50), decimal(18,2), varchar(MAX)... */
export function formatSqlType(
  type: string,
  maxLength: number | null,
  precision: number | null,
  scale: number | null,
): string {
  const t = type.toLowerCase();
  if (["varchar", "char", "varbinary", "binary"].includes(t)) {
    return `${type}(${maxLength === -1 ? "MAX" : maxLength})`;
  }
  if (["nvarchar", "nchar"].includes(t)) {
    return `${type}(${maxLength === -1 ? "MAX" : (maxLength ?? 0) / 2})`;
  }
  if (["decimal", "numeric"].includes(t)) {
    return `${type}(${precision},${scale})`;
  }
  if (["datetime2", "time", "datetimeoffset"].includes(t)) {
    return `${type}(${scale})`;
  }
  return type;
}
