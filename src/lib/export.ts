/** File names and paths for the export dialog. */
import type { ExportFormat } from "./api.ts";
import { splitStatements } from "./sqlsplit.ts";

export const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: "csv", label: "CSV" },
  { id: "json", label: "JSON" },
  { id: "sql", label: "SQL INSERTs" },
];

/** A name that is safe as a file name on every OS. */
export function safeFileName(name: string) {
  return name.replace(/[/\\:*?"<>|\x00-\x1f]+/g, "_").replace(/^[.\s]+|\s+$/g, "") || "export";
}

/** `dir` + `file`, with the separator `dir` already uses. */
export function joinPath(dir: string, file: string) {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[/\\]+$/, "") + sep + file;
}

/** Swaps an export extension (.csv / .json / .sql) for `format`'s; another one the user typed stays. */
export function withExtension(path: string, format: ExportFormat) {
  const m = /\.(csv|json|sql)$/i.exec(path);
  if (m) return path.slice(0, m.index) + "." + format;
  return path;
}

/**
 * The statement whose result is shown, to run again for an export: the only one, or the one
 * at `active` when each statement gave one result. Null when that can't be told.
 */
export function exportStatement(sql: string, resultCount: number, active: number): string | null {
  const statements = splitStatements(sql);
  if (statements.length === 1) return statements[0].text;
  if (statements.length === resultCount) return statements[active]?.text ?? null;
  return null;
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
