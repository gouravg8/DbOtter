/**
 * Statements worth a second look before they run on a production database: UPDATE or DELETE
 * without a WHERE, DROP, TRUNCATE, ALTER … DROP. Reads only the code, not strings, quoted
 * names or comments, and knows parentheses: a WHERE inside a subquery doesn't count for the
 * outer DELETE, while a DELETE inside a WITH does count.
 */
import { splitStatements } from "./sqlsplit.ts";

export interface Risk {
  statement: string;
  reason: string;
}

interface Word {
  w: string;
  depth: number;
}

/** Lower-cased words outside strings, quoted identifiers and comments, with paren depth. */
function words(sql: string): Word[] {
  const out: Word[] = [];
  let depth = 0;
  let i = 0;
  const n = sql.length;
  const skipQuoted = (q: string, backslash: boolean) => {
    i++;
    while (i < n) {
      if (backslash && sql[i] === "\\") i += 2;
      else if (sql[i] === q && sql[i + 1] === q) i += 2;
      else if (sql[i] === q) {
        i++;
        return;
      } else i++;
    }
  };
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "#" ) {
      // MySQL line comment
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      let level = 0;
      while (i < n) {
        if (sql[i] === "/" && sql[i + 1] === "*") (level++, (i += 2));
        else if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          if (--level === 0) break;
        } else i++;
      }
    } else if (c === "'") {
      skipQuoted("'", /[eE]/.test(sql[i - 1] ?? "") && !/\w/.test(sql[i - 2] ?? ""));
    } else if (c === '"' || c === "`") {
      skipQuoted(c, false);
    } else if (c === "$") {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
      } else i++;
    } else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w$]*/.exec(sql.slice(i, i + 128))![0];
      out.push({ w: m.toLowerCase(), depth });
      i += m.length;
    } else i++;
  }
  return out;
}

/** A WHERE at the same depth after `from`, before that depth's closing parenthesis. */
function hasWhereAfter(ws: Word[], from: number) {
  const depth = ws[from].depth;
  for (let j = from + 1; j < ws.length; j++) {
    if (ws[j].depth < depth) return false;
    if (ws[j].depth === depth && ws[j].w === "where") return true;
  }
  return false;
}

function riskOf(text: string): string | null {
  const ws = words(text);
  if (!ws.length) return null;
  const first = ws[0].w;
  if (first === "drop") return `DROP ${ws[1]?.w.toUpperCase() ?? ""}`.trim();
  if (first === "truncate") return "TRUNCATE";
  if (first === "alter" && ws.some((x, k) => k > 0 && x.w === "drop" && x.depth === 0)) return "ALTER … DROP";
  for (let k = 0; k < ws.length; k++) {
    const prev = ws[k - 1]?.w;
    // ON DELETE CASCADE in a definition is not a DELETE
    if (ws[k].w === "delete" && prev !== "on" && !hasWhereAfter(ws, k)) return "DELETE without WHERE";
    // FOR UPDATE (row locks), ON DUPLICATE KEY UPDATE, ON CONFLICT DO UPDATE, ON UPDATE CASCADE
    if (ws[k].w === "update" && !["for", "key", "do", "on"].includes(prev ?? "")) {
      const set = ws.findIndex((x, j) => j > k && x.w === "set" && x.depth === ws[k].depth);
      if (set !== -1 && !hasWhereAfter(ws, k)) return "UPDATE without WHERE";
    }
  }
  return null;
}

export function riskyStatements(sql: string): Risk[] {
  return splitStatements(sql)
    .map((s) => ({ statement: s.text, reason: riskOf(s.text) }))
    .filter((r): r is Risk => r.reason !== null);
}
