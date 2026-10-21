/**
 * MySQL / MariaDB and SQLite through the UI. SQLite always runs (the file is made here with
 * node:sqlite); MySQL needs DBOTTER_TEST_MYSQL_PORT (user root without password).
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const BRIDGE = "http://127.0.0.1:1430/api";
const MYSQL_PORT = Number(process.env.DBOTTER_TEST_MYSQL_PORT ?? 0);

async function api<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  const res = await fetch(BRIDGE, { method: "POST", body: JSON.stringify({ cmd, args: args ?? null }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${cmd}: ${JSON.stringify(body)}`);
  return body as T;
}

const pane = (page: Page) => page.locator(".tab-pane:not([hidden])");

test.beforeEach(async () => {
  for (const c of await api<{ id: string }[]>("connections_list")) await api("connection_delete", { id: c.id });
});

test("SQLite: add a file, browse, query, structure", async ({ page }) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dbotter-e2e-")), "store.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, data BLOB);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250)
      INSERT INTO items (name, price, data) SELECT 'Item ' || i, i * 1.5, CASE WHEN i % 50 = 0 THEN x'cafe' END FROM n;
    INSERT INTO items (name) VALUES ('O''Brien "50%_off"');
    CREATE VIEW cheap AS SELECT * FROM items WHERE price < 10;`);
  db.close();

  await page.goto("/");
  await page.getByTitle("New connection").click();
  await page.getByRole("radio", { name: "SQLite" }).click();
  await expect(page.locator(".field", { hasText: "Host" })).toHaveCount(0);
  await page.getByLabel("Database file").fill(file);
  await expect(page.locator(".field", { hasText: "Name" }).locator("input")).toHaveValue("store.db");
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.locator(".test-result")).toContainText(/Connected · SQLite 3\./);
  await page.getByRole("button", { name: "Save & connect" }).click();

  await page.locator(".tree-row", { hasText: "items" }).click();
  const foot = pane(page).locator(".results-foot");
  await expect(foot).toContainText("Rows 1–100");
  await expect(pane(page).locator(".grid-cell").nth(1)).toHaveText("Item 1");
  // numbers are right-aligned
  await expect(pane(page).locator(".grid-cell.num").first()).toHaveText("1");
  await foot.getByRole("button", { name: "Count" }).click();
  await expect(foot).toContainText("of 251");

  // sort and a literal % / _ / quote filter
  await pane(page).locator(".grid-hcell", { hasText: "price" }).click();
  await pane(page).locator(".grid-hcell", { hasText: "price" }).click();
  await expect(pane(page).locator(".grid-cell").nth(1)).toHaveText("Item 250");
  await pane(page).getByRole("button", { name: /Filter/ }).click();
  await pane(page).getByLabel("Column").first().selectOption("name");
  await pane(page).getByLabel("Operator").first().selectOption("contains");
  await pane(page).getByLabel("Value").first().fill('"50%_off"');
  await pane(page).getByLabel("Value").first().press("Enter");
  await expect(pane(page).locator(".grid-row")).toHaveCount(1);

  await pane(page).getByRole("tab", { name: "Structure" }).click();
  await expect(pane(page).locator(".definition")).toContainText("CREATE TABLE items");

  // query tab: SQLite dialect, several statements, errors labelled as such
  await page.keyboard.press("Control+t");
  await pane(page).locator(".cm-content").click();
  await page.keyboard.type("select count(*) as n from items where data is not null; select nope from items");
  await page.keyboard.press("Control+Shift+Enter");
  await expect(pane(page).locator(".error-panel")).toContainText("no such column");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("select count(*) as n from items where data is not null");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".grid-cell").first()).toHaveText("5");
  await expect(page.locator(".statusbar")).toContainText(/SQLite 3\./);
});

test("MySQL: connect, browse databases, query", async ({ page }) => {
  test.skip(!MYSQL_PORT, "set DBOTTER_TEST_MYSQL_PORT to run against MySQL / MariaDB");
  const conn = await api<{ id: string }>("connection_save", {
    input: { kind: "mysql", name: "My", host: "127.0.0.1", port: MYSQL_PORT, database: "", user: "root", sslMode: "prefer", savePassword: false },
  });
  await api("connect", { id: conn.id });
  await api("run_query", {
    id: conn.id,
    queryId: "seed",
    sql: "DROP DATABASE IF EXISTS otter_e2e; CREATE DATABASE otter_e2e; CREATE TABLE otter_e2e.`we``ird` (id INT AUTO_INCREMENT PRIMARY KEY, label VARCHAR(40), note TEXT); INSERT INTO otter_e2e.`we``ird` (label, note) VALUES ('alpha', NULL), ('it''s 50%_off', 'x'), ('gamma', 'y')",
  });
  await api("disconnect", { id: conn.id });

  await page.goto("/");
  await page.locator(".tree-row", { hasText: "My" }).click();
  // the first database may already be open
  const db = page.locator(".tree-row", { hasText: "otter_e2e" });
  await db.waitFor();
  if ((await db.getAttribute("aria-expanded")) !== "true") await db.click();
  await page.locator(".tree-row", { hasText: "we`ird" }).click();
  await expect(pane(page).locator(".grid-row")).toHaveCount(3);
  await expect(pane(page).locator(".grid-htype").first()).toHaveText("int");
  await pane(page).locator(".grid-cell", { hasText: "50%_off" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Filter: label =/ }).click();
  await expect(pane(page).locator(".grid-row")).toHaveCount(1);

  await page.keyboard.press("Control+t");
  await pane(page).locator(".cm-content").click();
  await page.keyboard.type("select label from otter_e2e.`we``ird` where note is null; select 6 * 7 as answer");
  await page.keyboard.press("Control+Shift+Enter");
  await expect(pane(page).locator(".result-tab")).toHaveCount(2);
  await expect(pane(page).locator(".grid-cell").first()).toHaveText("42");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("select nope from otter_e2e.`we``ird`");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".error-panel")).toContainText("Error 1054");
  await expect(page.locator(".statusbar")).toContainText(/(MySQL|MariaDB) \d/);
});
