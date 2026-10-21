/**
 * Editing grid cells: which result columns can be written back to which table, and the
 * changed rows as edits (primary key as loaded + new values) for the backend.
 */
import type { Cell, ColumnInfo, RowEdit } from "./api.ts";
import { tablesInStatement } from "./sqlscope.ts";

/** Changed cells by `row:column` index. */
export type Pending = Record<string, Cell>;

export const cellKey = (r: number, c: number) => `${r}:${c}`;

/** Types whose text form isn't how they're written back (hex, bits, geometry). */
const BINARY = /^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary|bit|geometry|point|linestring|polygon)\b/i;

export type Editability = { ok: true; pk: string[]; editable: boolean[] } | { ok: false; reason: string };

/**
 * Which of `resultColumns` can be edited, given the table's columns. `selected`: the
 * columns a query names (`null` for `*`); anything else in the result is computed.
 */
export function editability(resultColumns: string[], table: ColumnInfo[], selected: string[] | null = null): Editability {
  const pk = table.filter((c) => c.primaryKey).map((c) => c.name);
  if (!pk.length) return { ok: false, reason: "the table has no primary key, so a row can't be told apart" };
  const seen = new Map<string, number>();
  for (const c of resultColumns) seen.set(c, (seen.get(c) ?? 0) + 1);
  const missing = pk.filter((k) => seen.get(k) !== 1);
  if (missing.length) return { ok: false, reason: `the result needs the primary key (${missing.join(", ")}) once` };
  const byName = new Map(table.map((c) => [c.name, c]));
  const editable = resultColumns.map((name) => {
    const col = byName.get(name);
    if (!col || seen.get(name) !== 1) return false;
    if (selected && !selected.includes(name)) return false;
    // GENERATED ALWAYS AS (…) / ALWAYS AS IDENTITY can't be set
    if (col.generated && /always|stored|virtual/i.test(col.generated)) return false;
    return !BINARY.test(col.dataType);
  });
  if (!editable.some(Boolean)) return { ok: false, reason: "none of its columns can be edited" };
  return { ok: true, pk, editable };
}

/** The changed rows, one edit each, in row order. */
export function buildEdits(columns: string[], rows: Cell[][], pk: string[], pending: Pending): RowEdit[] {
  const byRow = new Map<number, [string, Cell][]>();
  for (const [k, v] of Object.entries(pending)) {
    const [r, c] = k.split(":").map(Number);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r)!.push([columns[c], v]);
  }
  return [...byRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([r, set]) => ({ key: pk.map((k): [string, Cell] => [k, rows[r][columns.indexOf(k)]]), set }));
}

/** `rows` with the pending values in (after saving). */
export function withPending(rows: Cell[][], pending: Pending): Cell[][] {
  const out = rows.slice();
  for (const [k, v] of Object.entries(pending)) {
    const [r, c] = k.split(":").map(Number);
    if (out[r] === rows[r]) out[r] = rows[r].slice();
    out[r][c] = v;
  }
  return out;
}

export function changedRows(pending: Pending) {
  return new Set(Object.keys(pending).map((k) => k.split(":")[0])).size;
}

export interface SimpleSelect {
  schema?: string;
  table: string;
  /** Named columns, or null for `*`. */
  columns: string[] | null;
}

const IDENT = String.raw`(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|\[[^\]]*\]|[A-Za-z_\u0080-￿][\w$\u0080-￿]*)`;
const unquote = (s: string) => {
  const q = s[0];
  if (q === '"' || q === "`") return s.slice(1, -1).replaceAll(q + q, q);
  if (q === "[") return s.slice(1, -1);
  return s;
};

/**
 * `SELECT *` or plain columns `FROM` one table (WHERE / ORDER BY / LIMIT allowed): the
 * result rows are that table's rows. Null for anything else (joins, expressions, GROUP BY…).
 */
export function simpleSelect(sql: string): SimpleSelect | null {
  // strings and comments out of the way (a string can't hold the words checked below)
  const code = sql
    .replace(/'(?:[^'\\]|''|\\.)*'/g, "''")
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
    .trim()
    .replace(/;\s*$/, "");
  const m = new RegExp(String.raw`^select\s+([\s\S]+?)\s+from\s+`, "i").exec(code);
  if (!m) return null;
  if (/\b(join|union|intersect|except|group\s+by|having|distinct|window|over|lateral)\b/i.test(code) || /\(\s*select\b/i.test(code)) return null;
  const refs = tablesInStatement(code);
  if (refs.length !== 1) return null;
  const ref = refs[0];
  const list = m[1].trim();
  if (list === "*" || (ref.alias && new RegExp(`^${IDENT}\\.\\*$`).test(list) && unquote(list.slice(0, -2)) === ref.alias)) {
    return { schema: ref.schema, table: ref.table, columns: null };
  }
  // a, t.b, "c": plain columns only (AS, functions and maths are computed values)
  const item = new RegExp(`^(?:${IDENT}\\s*\\.\\s*)?(${IDENT})$`);
  const columns: string[] = [];
  for (const part of list.split(",")) {
    const mm = item.exec(part.trim());
    if (!mm) return null;
    columns.push(unquote(mm[1]));
  }
  return { schema: ref.schema, table: ref.table, columns };
}
