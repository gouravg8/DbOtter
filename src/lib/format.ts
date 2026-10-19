import type { Cell, SslMode } from "./api";

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
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  sslMode?: SslMode;
}

const SSL_MODES: Record<string, SslMode> = {
  disable: "disable",
  allow: "prefer",
  prefer: "prefer",
  require: "require",
  "verify-ca": "verify-full",
  "verify-full": "verify-full",
};

/** postgres://user:pass@host:5432/db?sslmode=require (also postgresql://). Null if not a URL. */
export function parsePostgresUrl(input: string): ParsedUrl | null {
  const m = /^postgres(?:ql)?:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?(?:\/([^?#]*))?(?:\?([^#]*))?$/i.exec(
    input.trim(),
  );
  if (!m) return null;
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
    if (k === "sslmode" && SSL_MODES[v]) out.sslMode = SSL_MODES[v];
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
