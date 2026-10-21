import type { Cell, DbKind, SslMode } from "./api";

/* ---------- copying rows ---------- */

function csvField(v: Cell) {
  if (v === null) return "";
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(columns: string[], rows: Cell[][]) {
  return [columns, ...rows].map((r) => r.map(csvField).join(",")).join("\n");
}

/** Tab-separated, pastes straight into spreadsheets. NULL becomes an empty cell. */
export function toTsv(columns: string[] | null, rows: Cell[][]) {
  const clean = (v: Cell) => (v === null ? "" : v.replace(/[\t\n\r]+/g, " "));
  const lines = rows.map((r) => r.map(clean).join("\t"));
  return (columns ? [columns.join("\t"), ...lines] : lines).join("\n");
}

/** Array of objects; values stay Postgres text (no guessing of numbers or JSON). */
export function toJson(columns: string[], rows: Cell[][]) {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))),
    null,
    2,
  );
}

export const formatCount = (n: number) => n.toLocaleString("en-US");

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

export function timeAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/* ---------- connection URLs ---------- */

export interface ParsedUrl {
  kind: DbKind;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  sslMode?: SslMode;
}

const SSL_MODES: Record<string, SslMode> = {
  disable: "disable",
  disabled: "disable",
  preferred: "prefer",
  required: "require",
  verify_ca: "verify-full",
  verify_identity: "verify-full",
  allow: "prefer",
  prefer: "prefer",
  require: "require",
  "verify-ca": "verify-full",
  "verify-full": "verify-full",
};

/**
 * A connection string: postgres:// (postgresql://), mysql:// (mariadb://), sqlite:/path or
 * sqlite:///path, or just a path to a .db / .sqlite / .sqlite3 file. Null if it isn't one.
 */
export function parseConnectionUrl(input: string): ParsedUrl | null {
  const text = input.trim();
  const file = /^sqlite:(?:\/\/)?(.+)$/i.exec(text)?.[1] ?? (/^(~|\.{0,2})?\/.*\.(db|sqlite3?|db3)$/i.test(text) ? text : null);
  if (file) return { kind: "sqlite", database: file };
  const m = /^(postgres(?:ql)?|mysql|mariadb):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?(?:\/([^?#]*))?(?:\?([^#]*))?$/i.exec(
    text,
  );
  if (!m) return null;
  const kind: DbKind = /^postgres/i.test(m[1]) ? "postgres" : "mysql";
  m.splice(1, 1);
  // a raw % (e.g. in a password) isn't valid escaping: keep it as typed
  const dec = (s?: string) => {
    if (!s) return undefined;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const out: ParsedUrl = {
    kind,
    user: dec(m[1]),
    password: dec(m[2]),
    host: dec(m[3])?.replace(/^\[|\]$/g, "") || undefined,
    port: m[4] ? Number(m[4]) : undefined,
    database: dec(m[5]) || undefined,
  };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(m[6] ?? "");
  } catch {
    params = new URLSearchParams();
  }
  for (const [k, v] of params) {
    if ((k === "sslmode" || k === "ssl-mode") && SSL_MODES[v.toLowerCase()]) out.sslMode = SSL_MODES[v.toLowerCase()];
    if (k === "user" && !out.user) out.user = v;
    if (k === "password" && !out.password) out.password = v;
    if (k === "host" && !out.host) out.host = v;
    if ((k === "dbname" || k === "database") && !out.database) out.database = v;
  }
  return out;
}

/* ---------- fuzzy matching ---------- */

/**
 * Subsequence match ("cusor" matches "customers_orders"). Higher is better: consecutive
 * runs, word starts and early matches score more. Null when it doesn't match.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    run = found === ti ? run + 1 : 0;
    const wordStart = found === 0 || /[\s._\-/:]/.test(t[found - 1]);
    score += 1 + run * 2 + (wordStart ? 3 : 0) - Math.min(found - ti, 4) * 0.25;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 5;
  return score - t.length * 0.01;
}
