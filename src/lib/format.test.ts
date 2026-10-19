import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyScore, parsePostgresUrl, toCsv, toJson, toTsv } from "./format.ts";

test("csv quotes only when needed, NULL is empty", () => {
  assert.equal(toCsv(["a", "b"], [["1", null], ['x,"y"', "line\nbreak"]]), 'a,b\n1,\n"x,""y""","line\nbreak"');
});

test("tsv flattens tabs and newlines", () => {
  assert.equal(toTsv(null, [["a\tb", "c\nd", null]]), "a b\tc d\t");
});

test("json keeps text values and nulls", () => {
  assert.deepEqual(JSON.parse(toJson(["id", "x"], [["1", null]])), [{ id: "1", x: null }]);
});

test("parses postgres URLs", () => {
  assert.deepEqual(parsePostgresUrl("postgres://me:p%40ss@db.example.com:6543/shop?sslmode=require"), {
    user: "me",
    password: "p@ss",
    host: "db.example.com",
    port: 6543,
    database: "shop",
    sslMode: "require",
  });
  assert.deepEqual(parsePostgresUrl("postgresql://localhost/app"), {
    user: undefined,
    password: undefined,
    host: "localhost",
    port: undefined,
    database: "app",
  });
  assert.equal(parsePostgresUrl("postgres://[::1]:5432/x")?.host, "::1");
  assert.equal(parsePostgresUrl("postgres://u@h/d?sslmode=verify-ca")?.sslMode, "verify-full");
  // a raw % is not an escape: kept as typed instead of throwing
  assert.equal(parsePostgresUrl("postgres://me:50%off@h/d")?.password, "50%off");
  assert.equal(parsePostgresUrl("postgres://me:%E0%A4%A@h/d")?.password, "%E0%A4%A");
  assert.equal(parsePostgresUrl("mysql://x"), null);
  assert.equal(parsePostgresUrl("not a url"), null);
});

test("fuzzy score ranks prefix and word starts higher", () => {
  assert.equal(fuzzyScore("xyz", "customers"), null);
  const a = fuzzyScore("cust", "customers")!;
  const b = fuzzyScore("cust", "big_accounts_list")!;
  assert.ok(a > b);
  assert.ok(fuzzyScore("so", "sales.orders")! > fuzzyScore("so", "persons")!);
});
