import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyScore, parseConnectionUrl, toCsv, toJson, toTsv } from "./format.ts";

test("csv quotes only when needed, NULL is empty", () => {
  assert.equal(toCsv(["a", "b"], [["1", null], ['x,"y"', "line\nbreak"]]), 'a,b\n1,\n"x,""y""","line\nbreak"');
});

test("tsv flattens tabs and newlines", () => {
  assert.equal(toTsv(null, [["a\tb", "c\nd", null]]), "a b\tc d\t");
});

test("json keeps text values and nulls", () => {
  assert.deepEqual(JSON.parse(toJson(["id", "x"], [["1", null]])), [{ id: "1", x: null }]);
});

test("parses Postgres URLs", () => {
  assert.deepEqual(parseConnectionUrl("postgres://me:p%40ss@db.example.com:6543/shop?sslmode=require"), {
    kind: "postgres",
    user: "me",
    password: "p@ss",
    host: "db.example.com",
    port: 6543,
    database: "shop",
    sslMode: "require",
  });
  assert.deepEqual(parseConnectionUrl("postgresql://localhost/app"), {
    kind: "postgres",
    user: undefined,
    password: undefined,
    host: "localhost",
    port: undefined,
    database: "app",
  });
  assert.equal(parseConnectionUrl("postgres://[::1]:5432/x")?.host, "::1");
  assert.equal(parseConnectionUrl("postgres://u@h/d?sslmode=verify-ca")?.sslMode, "verify-full");
  // a raw % is not an escape: kept as typed instead of throwing
  assert.equal(parseConnectionUrl("postgres://me:50%off@h/d")?.password, "50%off");
  assert.equal(parseConnectionUrl("postgres://me:%E0%A4%A@h/d")?.password, "%E0%A4%A");
  assert.equal(parseConnectionUrl("not a url"), null);
  assert.equal(parseConnectionUrl("redis://x"), null);
});

test("parses MySQL URLs and SQLite paths", () => {
  const my = parseConnectionUrl("mysql://root:secret@127.0.0.1:3306/shop?ssl-mode=REQUIRED")!;
  assert.equal(my.kind, "mysql");
  assert.equal(my.port, 3306);
  assert.equal(my.database, "shop");
  assert.equal(my.sslMode, "require");
  assert.equal(parseConnectionUrl("mariadb://u@db/x")?.kind, "mysql");
  assert.deepEqual(parseConnectionUrl("sqlite:///home/me/app.db"), { kind: "sqlite", database: "/home/me/app.db" });
  assert.deepEqual(parseConnectionUrl("sqlite:data/app.sqlite"), { kind: "sqlite", database: "data/app.sqlite" });
  assert.deepEqual(parseConnectionUrl("~/notes.sqlite3"), { kind: "sqlite", database: "~/notes.sqlite3" });
  assert.equal(parseConnectionUrl("/etc/passwd"), null);
});

test("fuzzy score ranks prefix and word starts higher", () => {
  assert.equal(fuzzyScore("xyz", "customers"), null);
  const a = fuzzyScore("cust", "customers")!;
  const b = fuzzyScore("cust", "big_accounts_list")!;
  assert.ok(a > b);
  assert.ok(fuzzyScore("so", "sales.orders")! > fuzzyScore("so", "persons")!);
});

test("identifiers are quoted per dialect", async () => {
  const { quoteIdent, qualified } = await import("./dialect.ts");
  assert.equal(quoteIdent("postgres", 'we"ird'), '"we""ird"');
  assert.equal(quoteIdent("mysql", "we`ird"), "`we``ird`");
  assert.equal(qualified("sqlite", "main", "t"), '"main"."t"');
});
