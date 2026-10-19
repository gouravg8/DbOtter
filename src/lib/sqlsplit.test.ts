// Run with: pnpm test:unit (node's built-in test runner, TypeScript stripped natively)
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitStatements, statementAt } from "./sqlsplit.ts";

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

test("splits at top-level semicolons", () => {
  assert.deepEqual(texts("select 1; select 2;\n\nselect 3"), ["select 1", "select 2", "select 3"]);
  assert.deepEqual(texts("  ;; \n"), []);
});

test("ignores semicolons in strings, identifiers and comments", () => {
  assert.deepEqual(texts("select 'a;b', \"c;d\" from t; select 2"), ["select 'a;b', \"c;d\" from t", "select 2"]);
  assert.deepEqual(texts("select 'it''s;' ; select 2"), ["select 'it''s;'", "select 2"]);
  assert.deepEqual(texts("select E'\\';' ; select 2"), ["select E'\\';'", "select 2"]);
  assert.deepEqual(texts("select 1 -- a; b\n; select 2"), ["select 1 -- a; b", "select 2"]);
  assert.deepEqual(texts("select /* a; /* nested; */ b; */ 1; select 2"), ["select /* a; /* nested; */ b; */ 1", "select 2"]);
});

test("dollar quoting", () => {
  const fn = "create function f() returns int as $$ begin return 1; end; $$ language plpgsql";
  assert.deepEqual(texts(`${fn}; select 2`), [fn, "select 2"]);
  const tagged = "do $body$ begin perform 1; end $body$";
  assert.deepEqual(texts(`${tagged};select 3`), [tagged, "select 3"]);
  // $1 parameters are not dollar quotes
  assert.deepEqual(texts("select $1; select 2"), ["select $1", "select 2"]);
});

test("SQL-standard function bodies (BEGIN ATOMIC … END) stay whole", () => {
  const fn = `create function f(x int) returns int language sql
begin atomic
  select case when x > 0 then 1 else 0 end;
  select x + 1;
end`;
  assert.deepEqual(texts(`${fn}; select 2`), [fn, "select 2"]);
  // a plain BEGIN is a transaction start, split as usual
  assert.deepEqual(texts("begin; update t set a = 1; commit"), ["begin", "update t set a = 1", "commit"]);
  // words containing "end" / "case" don't count
  assert.deepEqual(texts("begin atomic select legend, showcase from t; end; select 3"), ["begin atomic select legend, showcase from t; end", "select 3"]);
});

test("leading comments are trimmed from the statement", () => {
  const [s] = splitStatements("-- count users\n/* note */\nselect count(*) from users;");
  assert.equal(s.text, "select count(*) from users");
});

test("statement at cursor", () => {
  const sql = "select 1;\nselect 2;\n\nselect 3";
  const at = (pos: number) => statementAt(sql, pos)?.text;
  assert.equal(at(0), "select 1");
  assert.equal(at(4), "select 1");
  assert.equal(at(9), "select 1"); // right after the semicolon
  assert.equal(at(10), "select 2"); // start of next line
  assert.equal(at(sql.indexOf("\n\n")), "select 2"); // end of line 2
  assert.equal(at(sql.indexOf("\n\n") + 1), "select 3"); // blank line before select 3
  assert.equal(at(sql.length), "select 3");
  assert.equal(statementAt("   ", 1), null);
  assert.equal(statementAt("select 1;\n\n", 11)?.text, "select 1");
});
