import assert from "node:assert/strict";
import { test } from "node:test";
import { riskyStatements } from "./risk.ts";

const reasons = (sql: string) => riskyStatements(sql).map((r) => r.reason);

test("flags writes without WHERE, DROP, TRUNCATE, ALTER … DROP", () => {
  assert.deepEqual(reasons("delete from orders"), ["DELETE without WHERE"]);
  assert.deepEqual(reasons("UPDATE customers SET vip = true"), ["UPDATE without WHERE"]);
  assert.deepEqual(reasons("drop table orders"), ["DROP TABLE"]);
  assert.deepEqual(reasons("TRUNCATE orders"), ["TRUNCATE"]);
  assert.deepEqual(reasons("alter table t drop column x"), ["ALTER … DROP"]);
  // MySQL multi-table forms
  assert.deepEqual(reasons("DELETE t FROM t JOIN u ON u.id = t.u"), ["DELETE without WHERE"]);
  assert.deepEqual(reasons("UPDATE t JOIN u ON u.id = t.u SET t.a = 1"), ["UPDATE without WHERE"]);
});

test("a WHERE makes them fine, but only at the right level", () => {
  assert.deepEqual(reasons("delete from orders where id = 1"), []);
  assert.deepEqual(reasons("update t set a = 1 where id in (select id from u)"), []);
  // the WHERE belongs to the subquery, not the UPDATE
  assert.deepEqual(reasons("update t set a = (select max(x) from u where u.k = 1)"), ["UPDATE without WHERE"]);
  // a DELETE inside a WITH still deletes
  assert.deepEqual(reasons("with d as (delete from t returning *) select count(*) from d"), ["DELETE without WHERE"]);
  assert.deepEqual(reasons("with d as (delete from t where a < 0 returning *) select * from d"), []);
});

test("words that look risky but aren't", () => {
  assert.deepEqual(reasons("select * from orders for update"), []);
  assert.deepEqual(reasons("create table c (p int references p (id) on delete cascade on update cascade)"), []);
  assert.deepEqual(reasons("insert into t values (1) on conflict (id) do update set a = excluded.a"), []);
  assert.deepEqual(reasons("insert into t values (1) on duplicate key update a = 2"), []);
  assert.deepEqual(reasons("select 'delete from orders', \"update\" from t -- drop table x"), []);
  assert.deepEqual(reasons("/* update t set a = 1 */ select 1"), []);
  assert.deepEqual(reasons("select $$ delete from t $$"), []);
});

test("one entry per risky statement of a batch", () => {
  const r = riskyStatements("select 1; delete from a; update b set x = 1 where id = 2; drop view v");
  assert.deepEqual(r.map((x) => [x.statement, x.reason]), [
    ["delete from a", "DELETE without WHERE"],
    ["drop view v", "DROP VIEW"],
  ]);
});
