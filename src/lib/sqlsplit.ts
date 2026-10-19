/**
 * Splits SQL into statements at top-level semicolons, skipping semicolons inside
 * strings ('...', E'...'), quoted identifiers, dollar quotes ($tag$...$tag$) and
 * comments (-- and nested /* *\/).
 */

export interface Statement {
  /** Offset of the first non-space character. */
  from: number;
  /** Offset just past the statement's last character, before any semicolon. */
  to: number;
  /** Offset past the terminating semicolon (or `to` when there is none). */
  end: number;
  text: string;
}

const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";

/** Ranges of code (not comments) that hold something other than whitespace. */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  // inside BEGIN ATOMIC … END (SQL-standard function bodies): CASE … END nests
  let atomic = 0;

  const push = (stop: number, end: number) => {
    let from = start;
    let to = stop;
    // trim whitespace and comments at the edges
    for (;;) {
      while (from < to && isSpace(sql[from])) from++;
      if (sql.startsWith("--", from)) {
        const nl = sql.indexOf("\n", from);
        from = nl === -1 || nl > to ? to : nl + 1;
        continue;
      }
      if (sql.startsWith("/*", from)) {
        const close = skipBlockComment(sql, from);
        if (close <= to) {
          from = close;
          continue;
        }
      }
      break;
    }
    while (to > from && isSpace(sql[to - 1])) to--;
    if (to > from) out.push({ from, to, end, text: sql.slice(from, to) });
  };

  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
    } else if (c === "'") {
      // E'...' strings treat backslash as an escape
      const escapes = i > 0 && (sql[i - 1] === "E" || sql[i - 1] === "e") && !isIdentChar(sql[i - 2]);
      i = skipQuoted(sql, i, "'", escapes);
    } else if (c === '"') {
      i = skipQuoted(sql, i, '"', false);
    } else if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag && !isIdentChar(sql[i - 1])) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
      } else i++;
    } else if (/[A-Za-z_]/.test(c) && !isIdentChar(sql[i - 1])) {
      const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i, i + 64))![0].toLowerCase();
      if (word === "begin" && /^\s+atomic\b/i.test(sql.slice(i + 5, i + 40))) atomic = 1;
      else if (atomic && word === "case") atomic++;
      else if (atomic && word === "end") atomic--;
      i += word.length;
    } else if (c === ";" && !atomic) {
      push(i, i + 1);
      i++;
      start = i;
    } else i++;
  }
  push(n, n);
  return out;
}

function isIdentChar(c: string | undefined) {
  return !!c && /[A-Za-z0-9_$]/.test(c);
}

function skipQuoted(sql: string, i: number, q: string, backslash: boolean) {
  let j = i + 1;
  while (j < sql.length) {
    if (backslash && sql[j] === "\\") j += 2;
    else if (sql[j] === q) {
      if (sql[j + 1] === q) j += 2;
      else return j + 1;
    } else j++;
  }
  return sql.length;
}

/** Postgres block comments nest. */
function skipBlockComment(sql: string, i: number) {
  let depth = 0;
  let j = i;
  while (j < sql.length) {
    if (sql[j] === "/" && sql[j + 1] === "*") {
      depth++;
      j += 2;
    } else if (sql[j] === "*" && sql[j + 1] === "/") {
      depth--;
      j += 2;
      if (depth === 0) return j;
    } else j++;
  }
  return sql.length;
}

/**
 * The statement the cursor is in. Between statements: the previous one while the cursor
 * is still on its line (`select 1;|`), otherwise the next one (or the last, at the end).
 */
export function statementAt(sql: string, pos: number): Statement | null {
  const all = splitStatements(sql);
  if (!all.length) return null;
  const inside = all.find((s) => pos >= s.from && pos <= s.end);
  if (inside) return inside;
  const prev = all.filter((s) => s.end <= pos).pop();
  const next = all.find((s) => s.from >= pos);
  if (prev && (!next || !sql.slice(prev.end, pos).includes("\n"))) return prev;
  return next ?? prev ?? null;
}
