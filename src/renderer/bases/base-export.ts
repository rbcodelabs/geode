import type { BaseDefinition } from "./base-file";
import { valueToDisplayString } from "./coerce";
import { columnDisplayName } from "./columns";
import type { QueryRow } from "./query-engine";

/**
 * Build a 2-D string matrix (header row of column display names + one row per
 * result) from a Bases view's visible columns and rows. The values are the
 * same rendered display strings the Table/Cards views show, so a Copy/Export
 * reflects exactly what the user sees (resolved formulas/summaries, dates
 * formatted, etc.), not raw frontmatter. Pure — the caller supplies the
 * already-filtered/sorted/grouped rows.
 */
export function buildExportMatrix(rows: QueryRow[], columns: string[], def: BaseDefinition): string[][] {
  const header = columns.map((path) => columnDisplayName(def, path));
  const body = rows.map((row) => columns.map((path) => displayFor(row, path)));
  return [header, ...body];
}

function displayFor(row: QueryRow, path: string): string {
  const v = row.properties[path];
  return v ? valueToDisplayString(v) : "";
}

/**
 * Serialize a matrix to RFC 4180 CSV: fields containing a comma, double
 * quote, or newline are wrapped in double quotes with embedded quotes
 * doubled. Rows are joined with CRLF (the RFC's line terminator).
 */
export function matrixToCsv(matrix: string[][]): string {
  return matrix.map((row) => row.map(csvField).join(",")).join("\r\n");
}

function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialize a matrix to tab-separated values for the clipboard — the format
 * spreadsheets (Sheets/Excel/Numbers) and Markdown tables paste cleanly from.
 * Tabs and newlines inside a field are replaced with spaces so the row/column
 * structure survives a naive paste.
 */
export function matrixToTsv(matrix: string[][]): string {
  return matrix.map((row) => row.map((f) => f.replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n");
}
