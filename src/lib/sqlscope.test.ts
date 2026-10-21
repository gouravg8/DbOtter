import assert from "node:assert/strict";
import { test } from "node:test";
import { expectsTable, tablesInStatement } from "./sqlscope.ts";

const names = (sql: string) => tablesInStatement(sql).map((r) => [r.schema ?? "", r.table, r.alias ?? ""].join("|"));

test("tables a statement uses, with schemas and aliases", () => {
  assert.deepEqual(names("select * from login_audit order by user_"), ["|login_audit|"]);
  assert.deepEqual(names("SELECT * FROM sales.orders o JOIN public.customers AS c ON c.id = o.customer_id WHERE "), [
    "sales|orders|o",
    "public|customers|c",
  ]);
  assert.deepEqual(names("select * from a, b x, `we``ird` where"), ["|a|", "|b|x", "|we`ird|"]);
  assert.deepEqual(names('update "My Table" set '), ["|My Table|"]);
  assert.deepEqual(names("insert into t (a, b) values (1, 2)"), ["|t|"]);
  assert.deepEqual(names("delete from t where "), ["|t|"]);
  assert.deepEqual(names("select * from t left join u using (id)"), ["|t|", "|u|"]);
});

test("subqueries, functions, strings and comments are not tables", () => {
  assert.deepEqual(names("select * from (select 1) s"), []);
  assert.deepEqual(names("select * from generate_series(1, 3) g"), []);
  assert.deepEqual(names("select 'from nope' -- from nope2\n from real_one"), ["|real_one|"]);
  // EXTRACT(… FROM col) reads as a table that won't exist: harmless, it adds no columns
  assert.deepEqual(names("select extract(day from created_at) from t"), ["|created_at|", "|t|"]);
});

test("where a table name is expected", () => {
  assert.equal(expectsTable("select * from "), true);
  assert.equal(expectsTable("select * from a join "), true);
  assert.equal(expectsTable("select * from a, "), true);
  assert.equal(expectsTable("select a, "), false);
  assert.equal(expectsTable("select * from a where "), false);
  assert.equal(expectsTable("select * from a order by "), false);
});
