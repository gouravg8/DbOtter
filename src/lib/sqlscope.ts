/**
 * The tables a statement reads or writes (FROM, JOIN, UPDATE, INTO, with aliases), so the
 * editor can suggest their columns without a `table.` prefix.
 */

export interface TableRef {
  schema?: string;
  table: string;
  alias?: string;
}

/** Words that end a table reference instead of naming an alias. */
const NOT_ALIAS = new Set(
  ("where join inner left right full cross outer natural on using group order limit offset fetch set values " +
    "union intersect except having window for returning lateral straight_join select into partition with " +
    "tablesample default lock")
    .split(" "),
);
const STARTS = new Set(["from", "join", "update", "into", "straight_join"]);

const TOKEN = /"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|'(?:[^'\\]|''|\\.)*'|--[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|[A-Za-z_\u0080-￿][\w$\u0080-￿]*|\S/g;

/** A name as written: quotes removed (`"a""b"` -> `a"b`), or null for anything else. */
function ident(tok: string | undefined): string | null {
  if (!tok) return null;
  const q = tok[0];
  if ((q === '"' || q === "`") && tok.length >= 2) return tok.slice(1, -1).replaceAll(q + q, q);
  if (q === "[") return tok.slice(1, -1);
  return /^[A-Za-z_\u0080-￿]/.test(tok) ? tok : null;
}

const isComment = (t: string) => t.startsWith("--") || t.startsWith("/*") || (t.startsWith("#") && t.length > 1);

export function tablesInStatement(sql: string): TableRef[] {
  const toks = (sql.match(TOKEN) ?? []).filter((t) => !isComment(t) && !t.startsWith("'"));
  const out: TableRef[] = [];
  const lower = (i: number) => toks[i]?.toLowerCase();
  // one `name [.name] [AS] [alias]` at i; returns the index after it, or -1
  // `calls`: a name followed by ( is a function (FROM generate_series(…)), not INTO t (cols)
  const ref = (i: number, calls: boolean): number => {
    let name = ident(toks[i]);
    if (!name || NOT_ALIAS.has(name.toLowerCase()) || (calls && toks[i + 1] === "(")) return -1;
    let schema: string | undefined;
    let j = i + 1;
    if (toks[j] === "." && ident(toks[j + 1])) {
      schema = name;
      name = ident(toks[j + 1])!;
      j += 2;
    }
    if (lower(j) === "as") j++;
    const a = ident(toks[j]);
    const alias = a && !NOT_ALIAS.has(a.toLowerCase()) && !STARTS.has(a.toLowerCase()) ? a : undefined;
    if (alias) j++;
    out.push({ schema, table: name, alias });
    return j;
  };
  for (let i = 0; i < toks.length; i++) {
    const w = lower(i);
    if (!w || !STARTS.has(w)) continue;
    // DELETE FROM / INSERT INTO / SELECT … FROM, and comma-separated FROM lists
    const calls = w !== "into" && w !== "update";
    let j = ref(i + 1, calls);
    while (j > 0 && w === "from" && toks[j] === ",") j = ref(j + 1, calls);
  }
  return out;
}

/** Whether the word before `pos` asks for a table name (`FROM |`, `JOIN |`…), not a column. */
export function expectsTable(sqlBefore: string): boolean {
  const toks = (sqlBefore.match(TOKEN) ?? []).filter((t) => !isComment(t));
  const last = toks.at(-1)?.toLowerCase();
  return !!last && (STARTS.has(last) || last === "table" || (last === "," && isInFromList(toks)));
}

/** `FROM a, |`: after a comma that continues a FROM list. */
function isInFromList(toks: string[]) {
  for (let i = toks.length - 2; i >= 0; i--) {
    const w = toks[i].toLowerCase();
    if (w === "from") return true;
    if (w === "(" || w === ")" || w === "select" || NOT_ALIAS.has(w)) return false;
  }
  return false;
}
