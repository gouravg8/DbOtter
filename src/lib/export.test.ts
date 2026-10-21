import assert from "node:assert/strict";
import { test } from "node:test";
import { exportStatement, formatBytes, joinPath, safeFileName, withExtension } from "./export.ts";

test("file names and paths", () => {
  assert.equal(safeFileName('we/ird: "name"?'), "we_ird_ _name_");
  assert.equal(safeFileName("..hidden"), "hidden");
  assert.equal(safeFileName("///"), "_");
  assert.equal(safeFileName(""), "export");
  assert.equal(joinPath("/home/me/Downloads/", "a.csv"), "/home/me/Downloads/a.csv");
  assert.equal(joinPath("C:\\Users\\me\\Downloads", "a.csv"), "C:\\Users\\me\\Downloads\\a.csv");
  assert.equal(withExtension("/x/orders.csv", "json"), "/x/orders.json");
  assert.equal(withExtension("/x/orders.JSON", "sql"), "/x/orders.sql");
  assert.equal(withExtension("/x/orders.txt", "sql"), "/x/orders.txt");
});

test("the statement behind the shown result", () => {
  assert.equal(exportStatement("select 1;", 1, 0), "select 1");
  assert.equal(exportStatement("set x = 1; select 2; select 3", 3, 1), "select 2");
  // a statement gave no result (or the engine split differently): can't tell
  assert.equal(exportStatement("select 1; select 2", 1, 0), null);
});

test("sizes", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1921494), "1.8 MB");
  assert.equal(formatBytes(50 * 1024 ** 3), "50 GB");
});
