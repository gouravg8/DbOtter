/**
 * Needs the `shop` test database (scripts/seed-test-db.sql) on DBOTTER_TEST_PORT, with a
 * trust-auth `postgres` role and a password-auth `otter` role (password `otter-pass`).
 */
import { expect, test, type Page } from "@playwright/test";

const PORT = Number(process.env.DBOTTER_TEST_PORT ?? 0);
const BRIDGE = "http://127.0.0.1:1430/api";

test.skip(!PORT, "set DBOTTER_TEST_PORT to run against a test database");

async function api<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  const res = await fetch(BRIDGE, { method: "POST", body: JSON.stringify({ cmd, args: args ?? null }) });
  const body = await res.json();
  if (!res.ok) throw new Error(`${cmd}: ${JSON.stringify(body)}`);
  return body as T;
}

/** Fresh backend state and a saved trust-auth connection. */
async function reset(name = "Shop") {
  for (const c of await api<{ id: string }[]>("connections_list")) await api("connection_delete", { id: c.id });
  await api("history_clear");
  return api<{ id: string }>("connection_save", {
    input: { name, host: "127.0.0.1", port: PORT, database: "shop", user: "postgres", sslMode: "disable", savePassword: false },
  });
}

/** Opens the app with optional saved settings (localStorage starts empty in each test). */
async function open(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript((s) => {
    if (!localStorage.getItem("dbotter"))
      localStorage.setItem("dbotter", JSON.stringify({ state: { settings: s }, version: 2 }));
  }, settings);
  await page.goto("/");
}

async function connect(page: Page, name = "Shop") {
  await page.locator(".tree-row", { hasText: name }).dblclick();
  await expect(page.locator(".tree-row", { hasText: "customers" })).toBeVisible();
}

const pane = (page: Page) => page.locator(".tab-pane:not([hidden])");
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test.beforeEach(async () => {
  await reset();
});

test("add a connection from a URL; password prompt; keychain stays off", async ({ page }) => {
  await open(page);
  await page.locator(".tree-row", { hasText: "Shop" }).waitFor();
  await page.getByTitle("New connection").click();
  await page.getByLabel("Connection URL").fill(`postgres://otter@127.0.0.1:${PORT}/shop?sslmode=disable`);
  await expect(page.locator(".field", { hasText: "Host" }).locator("input")).toHaveValue("127.0.0.1");
  await expect(page.locator(".field", { hasText: "Port" }).locator("input")).toHaveValue(String(PORT));
  await page.locator(".field", { hasText: "Name" }).locator("input").fill("Otter");
  await page.locator(".check", { hasText: "Save password" }).locator("input").uncheck();

  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.locator(".test-result")).toContainText("Password required");

  await page.locator('.modal input[type="password"]').fill("otter-pass");
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.locator(".test-result")).toContainText(/Connected · PostgreSQL \d+/);

  // saved without a password: connecting asks for one
  await page.locator('.modal input[type="password"]').fill("");
  await page.getByRole("button", { name: "Save & connect" }).click();
  await expect(page.getByRole("dialog")).toContainText("Password for Otter");
  const pw = page.locator('.modal input[type="password"]');
  await pw.fill("wrong");
  await pw.press("Enter");
  await expect(page.locator(".modal .test-result")).toContainText("password authentication failed");
  await page.locator(".modal .check input").uncheck();
  await pw.fill("otter-pass");
  await pw.press("Enter");
  await expect(page.locator(".tree-row", { hasText: "Otter" }).locator(".live")).toBeVisible();
  await expect(page.locator(".tree-row", { hasText: "customers" })).toBeVisible();
  // "remember" was off: nothing went to the keychain
  const saved = (await api<{ name: string; savePassword: boolean }[]>("connections_list")).find((c) => c.name === "Otter");
  expect(saved?.savePassword).toBe(false);
});

test("browse a table: sort, filter, count, value viewer, structure", async ({ page }) => {
  await open(page);
  await connect(page);
  await page.locator(".tree-row", { hasText: "customers" }).click();
  const foot = pane(page).locator(".results-foot");
  await expect(foot).toContainText("Rows 1–100");
  await expect(foot).toContainText("of ~2,501");
  await expect(pane(page).locator(".grid-htype").first()).toHaveText("integer");

  // header click: ascending, then descending
  const firstId = pane(page).locator(".grid-row").first().locator(".grid-cell").first();
  await pane(page).locator(".grid-hcell", { hasText: "id" }).first().click();
  await pane(page).locator(".grid-hcell", { hasText: "id" }).first().click();
  await expect(firstId).toHaveText("2501");

  // filter from a cell's context menu, then count exactly
  await pane(page).locator(".grid-cell", { hasText: "Germany" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: /Filter: country = Germany/ }).click();
  await expect(pane(page).getByRole("button", { name: /Filter · 1/ })).toBeVisible();
  await foot.getByRole("button", { name: "Count" }).click();
  await expect(foot).toContainText("of 500");

  // a value with quotes and LIKE wildcards matches literally
  await pane(page).getByRole("button", { name: "Clear" }).click();
  await pane(page).getByRole("button", { name: "Add filter" }).click();
  await pane(page).getByLabel("Column").first().selectOption("name");
  await pane(page).getByLabel("Operator").first().selectOption("contains");
  await pane(page).getByLabel("Value").first().fill('"the 50%_off"');
  await pane(page).getByLabel("Value").first().press("Enter");
  await expect(pane(page).locator(".grid-row")).toHaveCount(1);

  // value viewer pretty-prints JSON
  await pane(page).getByRole("button", { name: "Clear" }).click();
  await pane(page).getByLabel("Raw WHERE condition").fill("id = 3");
  await pane(page).getByLabel("Raw WHERE condition").press("Enter");
  await expect(pane(page).locator(".grid-row")).toHaveCount(1);
  await pane(page).locator(".grid-cell", { hasText: '"plan"' }).dblclick();
  await expect(page.locator(".value-view")).toHaveText('{\n  "plan": "pro",\n  "seats": 3\n}');
  await page.keyboard.press("Escape");

  // a bad raw condition shows the Postgres error
  await pane(page).getByLabel("Raw WHERE condition").fill("nope = 1");
  await pane(page).getByLabel("Raw WHERE condition").press("Enter");
  await expect(pane(page).locator(".error-panel")).toContainText('column "nope" does not exist');

  await pane(page).getByRole("tab", { name: "Structure" }).click();
  await expect(pane(page).locator(".structure")).toContainText("People who bought something");
  await expect(pane(page).locator(".info-table").first()).toContainText("timestamp with time zone");
  await expect(pane(page).locator(".structure")).toContainText("customers_email_key");
  await expect(pane(page).locator(".structure")).not.toContainText("not_null");
});

test("grid keyboard with vim keys, selection and copy formats", async ({ page }) => {
  await open(page, { vim: true });
  await connect(page);
  await page.locator(".tree-row", { hasText: "customers" }).click();
  const grid = pane(page).locator(".grid");
  await pane(page).locator(".grid-cell").first().click(); // id of row 1
  await page.keyboard.press("j");
  await page.keyboard.press("l");
  await page.keyboard.press("y");
  expect(await clipboard(page)).toBe("Customer 2");

  await page.keyboard.press("G");
  await expect(pane(page).locator(".grid-cell.active")).toHaveText("Customer 100");
  await page.keyboard.type("gg");
  await expect(pane(page).locator(".grid-cell.active")).toHaveText("Customer 1");
  await page.keyboard.press("$");
  await page.keyboard.press("0");
  await expect(pane(page).locator(".grid-cell.active")).toHaveText("1");

  // Shift+arrows select a block; Ctrl+C copies it as TSV
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(grid.locator(".grid-selinfo")).toContainText("2 × 2 selected");
  await page.keyboard.press("Control+c");
  expect(await clipboard(page)).toBe("1\tCustomer 1\n2\tCustomer 2");
  await page.keyboard.press("Shift+Y");
  expect((await clipboard(page)).split("\n")[0]).toBe("id\tname\temail\tcountry\tvip\tmeta\ttags\tcreated_at");

  await pane(page).locator(".grid-cell").nth(1).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as JSON" }).click();
  expect(JSON.parse(await clipboard(page))).toEqual([{ id: "1", name: "Customer 1" }, { id: "2", name: "Customer 2" }]);

  // ] next page; row numbers continue
  await page.keyboard.press("]");
  await expect(pane(page).locator(".results-foot")).toContainText("Rows 101–200");
  await expect(pane(page).locator(".grid-gutter").first()).toHaveText("101");
});

test("queries: statement under cursor, results, errors, limits, cancel", async ({ page }) => {
  await open(page);
  await connect(page);
  await page.keyboard.press("Control+t");
  const editor = pane(page).locator(".cm-content");
  await editor.click();
  await page.keyboard.type("select count(*) as n from customers;\nselect id, nam from customers;");
  // cursor is on line 2: only that statement runs, the error points at "nam"
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".error-panel")).toContainText('column "nam" does not exist');
  await expect(pane(page).locator(".error-panel")).toContainText("Line 2");
  await expect(pane(page).locator(".cm-sql-error")).toHaveText("nam");

  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".grid-cell").first()).toHaveText("2501");

  // running closes an open autocomplete popup
  await page.keyboard.press("Control+a");
  await page.keyboard.type("select 1 as abc from custom");
  await expect(page.locator(".cm-tooltip-autocomplete")).toBeVisible();
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
  await expect(pane(page).locator(".error-panel")).toContainText('relation "custom" does not exist');

  // several statements: one result tab each, the last with rows is shown
  await page.keyboard.press("Control+a");
  await page.keyboard.type("create temp table t(x int); insert into t values (1),(2); select * from t order by x");
  await page.keyboard.press("Control+Shift+Enter");
  await expect(pane(page).locator(".result-tab")).toHaveCount(3);
  await expect(pane(page).locator(".result-tab.active")).toHaveText("3. 2 rows");
  await pane(page).locator(".result-tab").nth(1).click();
  await expect(pane(page).locator(".results-message")).toContainText("2 rows affected");

  // the row limit stops a 1M-row query early
  await editor.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("select * from sales.orders");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".results-foot")).toContainText("First 5,000 of 1,000,000 rows");

  // the tab keeps its own connection: a temp table survives between separate runs
  await page.keyboard.press("Control+a");
  await page.keyboard.type("create temp table scratch as select 41 + 1 as v");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".results-message")).toContainText("Statement OK");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("select v from scratch");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".grid-cell").first()).toHaveText("42");

  // cancel a slow query
  await page.keyboard.press("Control+a");
  await page.keyboard.type("select pg_sleep(30)");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".results-running")).toContainText("Running");
  await pane(page).getByRole("button", { name: "Cancel" }).first().click();
  await expect(pane(page).locator(".error-panel")).toContainText("canceling statement due to user request");

  // history keeps all of it
  await page.keyboard.press("Control+Shift+H");
  await expect(pane(page).locator(".history-item").first()).toContainText("select pg_sleep(30)");
  await pane(page).getByLabel("Search history").fill("count customers");
  await expect(pane(page).locator(".history-item")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(pane(page).locator(".cm-content")).toHaveText("select count(*) as n from customers");
});

test("keyboard-first: palette, go to table, sidebar, tabs", async ({ page }) => {
  await open(page);
  await connect(page);

  // Ctrl+P: fuzzy go-to-table
  await page.keyboard.press("Control+p");
  await page.keyboard.type("revstat");
  await expect(page.locator(".palette-item.active")).toContainText("sales.revenue_by_status");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active")).toContainText("revenue_by_status");
  await expect(pane(page).locator(".badge")).toHaveText("materialized view");

  // sidebar: focus, search, Enter opens the first match
  await page.keyboard.press("Control+Shift+E");
  await page.keyboard.press("/");
  await page.keyboard.type("big");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active")).toContainText("big_orders");
  // focus stays in the tree; Ctrl+E jumps into the grid
  await expect(pane(page).locator(".grid-cell").first()).toBeVisible();
  await expect(page.locator(".tree")).toBeFocused();
  await page.keyboard.press("Control+e");
  await expect(pane(page).locator(".grid")).toBeFocused();

  // tree keys: j/k, s opens structure
  await page.keyboard.press("Control+Shift+E");
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await page.keyboard.press("j");
  await expect(page.locator(".tree-row.focused")).toContainText("customers");
  await page.keyboard.press("s");
  await expect(page.locator(".tab.active")).toContainText("customers");
  await expect(pane(page).getByRole("tab", { name: "Structure" })).toHaveAttribute("aria-selected", "true");

  // palette actions and tab switching
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("new query");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab")).toHaveCount(4);
  await page.keyboard.press("Control+1");
  await expect(page.locator(".tab.active")).toContainText("revenue_by_status");
  await page.keyboard.press("Control+w");
  await expect(page.locator(".tab")).toHaveCount(3);
  await page.keyboard.press("Control+b");
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await page.keyboard.press("Control+b");
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("themes: switch, import a custom one, reject a bad file", async ({ page }) => {
  await open(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface").trim());
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("catppuccin mocha");
  await page.keyboard.press("Enter");
  await expect.poll(bg).toBe("#1e1e2e");
  await expect(page.locator(".statusbar")).toContainText("Catppuccin Mocha");

  await page.keyboard.press("Control+,");
  const file = page.locator('.settings input[type="file"]');
  await file.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"name":"X","appearance":"dark","colors":{"bg":"red"}}') });
  await expect(page.locator(".settings .test-result")).toContainText('"bg" must be a hex color');
  const theme = { name: "Deep Sea", appearance: "dark", colors: { surface: "#001122", accent: "#00ccff" } };
  await file.setInputFiles({ name: "deep-sea.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(theme)) });
  await expect.poll(bg).toBe("#001122");
  await expect(page.locator(".theme-card.selected")).toContainText("Deep Sea");

  // survives a restart
  await page.reload();
  await expect.poll(bg).toBe("#001122");
});

test("tabs and query text are restored after a restart", async ({ page }) => {
  await open(page);
  await connect(page);
  await page.locator(".tree-row", { hasText: "customers" }).click();
  await page.keyboard.press("Control+t");
  await pane(page).locator(".cm-content").click();
  await page.keyboard.type("select 'kept' as v");
  await page.reload();
  await expect(page.locator(".tab")).toHaveCount(2);
  await expect(pane(page).locator(".cm-content")).toHaveText("select 'kept' as v");
  // the restored table tab reconnects on its own when shown
  await page.locator(".tab", { hasText: "customers" }).click();
  await expect(pane(page).locator(".results-foot")).toContainText("Rows 1–100");
});

test("vim mode in the editor: keys go to vim, :q closes, Ctrl+Shift+T reopens", async ({ page }) => {
  await open(page, { vim: true });
  await connect(page);
  await page.keyboard.press("Control+t");
  const editor = pane(page).locator(".cm-content");
  await editor.click();
  await expect(page.locator(".vim-badge")).toHaveText(/NORMAL/);
  await page.keyboard.press("i");
  await expect(page.locator(".vim-badge")).toHaveText(/INSERT/);
  await page.keyboard.type("select 1 as one, 2 as two");
  // Ctrl+W deletes the last word in insert mode instead of closing the tab
  await page.keyboard.press("Control+w");
  await expect(editor).toHaveText("select 1 as one, 2 as ");
  await expect(page.locator(".tab")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".vim-badge")).toHaveText(/NORMAL/);
  // undo / redo (Ctrl+R goes to vim, not to the app's refresh)
  await page.keyboard.press("u");
  await expect(editor).not.toHaveText("select 1 as one, 2 as ");
  await page.keyboard.press("Control+r");
  await expect(editor).toHaveText("select 1 as one, 2 as ");
  // normal-mode editing, then run from normal mode
  await page.keyboard.type("ciwthree");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".results-foot")).toContainText("1 row");
  // :q closes the tab, Ctrl+Shift+T brings it back with its SQL
  await page.keyboard.type(":q");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator(".tab")).toHaveCount(1);
  await expect(pane(page).locator(".cm-content")).toContainText("select 1 as one");
});

test("sessions: disconnect sticks, edited connections reconnect, odd URLs don't crash", async ({ page }) => {
  await open(page);
  await connect(page);
  await page.locator(".tree-row", { hasText: "customers" }).click();
  await expect(pane(page).locator(".results-foot")).toContainText("Rows 1–100");
  // disconnecting while a table tab is open doesn't reconnect behind your back
  await page.locator(".tree-row", { hasText: "Shop" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect(pane(page).locator(".center-msg")).toContainText("Not connected");
  await page.waitForTimeout(500);
  await expect(pane(page).locator(".center-msg")).toContainText("Not connected");
  await pane(page).getByRole("button", { name: "Connect" }).click();
  await expect(pane(page).locator(".results-foot")).toContainText("Rows 1–100");

  // two tabs running on a disconnected connection share one connect: both get results
  for (const [i, sql] of ["select 'first' as v", "select 'second' as v"].entries()) {
    await page.keyboard.press("Control+t");
    await pane(page).locator(".cm-content").click();
    await page.keyboard.type(sql);
    if (i === 0) {
      await page.locator(".tree-row", { hasText: "Shop" }).first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Disconnect" }).click();
      await pane(page).locator(".cm-content").click();
    }
  }
  await page.keyboard.press("Control+2");
  await page.keyboard.press("Control+Enter");
  await page.keyboard.press("Control+3");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".grid-cell").first()).toHaveText("second");
  await page.keyboard.press("Control+2");
  await expect(pane(page).locator(".grid-cell").first()).toHaveText("first");
  await page.keyboard.press("Control+1");

  // editing an open connection: the backend reconnects it, the UI keeps working
  await page.locator(".tree-row", { hasText: "Shop" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit connection" }).click();
  await page.locator(".field", { hasText: "Name" }).locator("input").fill("Shop edited");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".tree-row", { hasText: "Shop edited" }).locator(".live")).toBeVisible();
  await page.keyboard.press("Control+r");
  await expect(pane(page).locator(".results-foot")).toContainText("Rows 1–100");

  // a raw % in a pasted URL is kept, not a crash
  await page.getByTitle("New connection").click();
  await page.getByLabel("Connection URL").fill("postgres://me:50%off@db.example.com/app");
  await expect(page.locator(".field", { hasText: "Host" }).locator("input")).toHaveValue("db.example.com");
  await expect(page.locator(".field", { hasText: "Name" }).locator("input")).toHaveValue("app@db.example.com");
  await page.getByLabel("Connection URL").fill("postgres://me:50%off@other.example.com/app2");
  await expect(page.locator(".field", { hasText: "Name" }).locator("input")).toHaveValue("app2@other.example.com");
  await page.locator(".field", { hasText: "Port" }).locator("input").fill("70000");
  await expect(page.getByRole("button", { name: "Save & connect" })).toBeDisabled();
  await page.keyboard.press("Escape");

  // in the palette Ctrl+K / Ctrl+P move the selection instead of toggling
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette")).toBeVisible();
  await expect(page.locator(".palette-item").nth(1)).toHaveClass(/active/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".palette")).toHaveCount(0);

  // Ctrl+Shift+P opens and closes it; Ctrl+K no longer does
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator(".palette-input input")).toHaveAttribute("placeholder", /command/);
  await page.keyboard.press("Control+Shift+P");
  await expect(page.locator(".palette")).toHaveCount(0);
});

test("keys: F5 refreshes, no reloads from dialogs, viewer copy, grid Tab, settings on Escape", async ({ page }) => {
  await open(page);
  await connect(page);
  await page.locator(".tree-row", { hasText: "customers" }).click();
  const foot = pane(page).locator(".results-foot");
  await foot.getByRole("button", { name: "Count" }).click();
  await expect(foot).toContainText("of 2,501");
  // F5 refreshes the table (the exact count resets)
  await pane(page).locator(".grid").focus();
  await page.keyboard.press("F5");
  await expect(foot.getByRole("button", { name: "Count" })).toBeVisible();

  // Ctrl+R / F5 inside dialogs and the palette never reload the page
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 42));
  await page.keyboard.press("Control+,");
  await expect(page.locator(".settings")).toBeVisible();
  await page.keyboard.press("Control+r");
  await page.keyboard.press("F5");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.press("Control+r");
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(42);

  // grid: first Tab selects the first cell, Ctrl+Tab switches tabs without moving it
  await page.keyboard.press("Control+t");
  await page.keyboard.press("Control+1");
  const grid = pane(page).locator(".grid");
  await grid.focus();
  await page.keyboard.press("Tab");
  await expect(pane(page).locator(".grid-cell.active")).toHaveText("1");
  await page.keyboard.press("Control+Tab");
  await page.keyboard.press("Control+Shift+Tab");
  await expect(pane(page).locator(".grid-cell.active")).toHaveText("1");

  // value viewer: Ctrl+C copies the value
  await grid.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.locator(".value-view")).toHaveText("Customer 1");
  await page.keyboard.press("Control+c");
  expect(await clipboard(page)).toBe("Customer 1");
  await page.keyboard.press("Escape");

  // settings: a typed number is kept when the dialog closes with Escape
  await page.keyboard.press("Control+,");
  const maxRows = page.locator(".field", { hasText: "Max rows" }).locator("input");
  await maxRows.fill("12000");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+,");
  await expect(page.locator(".field", { hasText: "Max rows" }).locator("input")).toHaveValue("12000");
  await page.keyboard.press("Escape");

  // reopening a closed History tab while another is open doesn't duplicate it
  await page.keyboard.press("Control+Shift+H");
  await page.keyboard.press("Control+w");
  await page.keyboard.press("Control+Shift+H");
  await page.keyboard.press("Control+Shift+T");
  await expect(page.locator(".tab", { hasText: "History" })).toHaveCount(1);
});

test("settings saved by v0.0.1 with the old 200-row default move to 100", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("dbotter", JSON.stringify({ state: { settings: { pageSize: 200 } }, version: 1 })),
  );
  await page.goto("/");
  await connect(page);
  await page.locator(".tree-row", { hasText: "customers" }).click();
  await expect(pane(page).locator(".results-foot")).toContainText("Rows 1–100");
});

test("connections connect on double-click; a single click does nothing", async ({ page }) => {
  await open(page);
  const row = page.locator(".tree-row", { hasText: "Shop" });
  await row.click();
  await page.waitForTimeout(400);
  await expect(row.locator(".live")).toHaveCount(0);
  await expect(page.locator(".tree-row", { hasText: "customers" })).toHaveCount(0);
  await expect(row).toHaveAttribute("title", "Double-click to connect");

  await row.dblclick();
  await expect(row.locator(".live")).toBeVisible();
  await expect(page.locator(".tree-row", { hasText: "customers" })).toBeVisible();
  // connected: a double-click closes and opens it, so does one click on the arrow
  await row.dblclick();
  await expect(page.locator(".tree-row", { hasText: "customers" })).toHaveCount(0);
  await row.locator(".chev").click();
  await expect(page.locator(".tree-row", { hasText: "customers" })).toBeVisible();
  // a single click on a connected row still does nothing
  await row.click();
  await page.waitForTimeout(300);
  await expect(page.locator(".tree-row", { hasText: "customers" })).toBeVisible();
});

test("read-only connections refuse writes and say so", async ({ page }) => {
  await open(page);
  await page.locator(".tree-row", { hasText: "Shop" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit connection" }).click();
  await page.locator(".check", { hasText: "Read-only" }).locator("input").check();
  await page.getByRole("button", { name: "Save & connect" }).click();
  await expect(page.locator(".tree-row", { hasText: "Shop" }).getByLabel("Read-only")).toBeVisible();
  await expect(page.locator(".statusbar .ro-badge")).toHaveText(/read-only/);
  await page.keyboard.press("Control+t");
  await pane(page).locator(".cm-content").click();
  await page.keyboard.type("update customers set name = 'x' where id = 1");
  await page.keyboard.press("Control+Enter");
  await expect(pane(page).locator(".error-panel")).toContainText("read-only transaction");
});

test("tab menu: close others, left, right, all, by connection", async ({ page }) => {
  await api("connection_save", {
    input: { name: "Second", host: "127.0.0.1", port: PORT, database: "shop", user: "postgres", sslMode: "disable", savePassword: false },
  });
  await open(page);
  await connect(page, "Shop");
  await connect(page, "Second");
  const shop = page.locator(".tree-row", { hasText: "customers" });
  // tabs: customers (Shop), Weird (Shop), customers (Second), Query 1
  await shop.first().click();
  await page.locator(".tree-row", { hasText: "Weird" }).first().click();
  await shop.nth(1).click();
  await page.keyboard.press("Control+t");
  const tabs = page.locator(".tab");
  await expect(tabs).toHaveCount(4);
  const menuOn = async (i: number, item: RegExp | string) => {
    await tabs.nth(i).click({ button: "right" });
    await page.getByRole("menuitem", { name: item, exact: typeof item === "string" }).click();
  };

  await menuOn(1, "Close tabs to the right");
  await expect(tabs).toHaveCount(2);
  await expect(page.locator(".tab.active")).toContainText("Weird");
  // reopens the last one closed: Query 1 (on "Second", the active connection when it was made)
  await page.keyboard.press("Control+Shift+T");
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(2)).toContainText("Query 1");

  await menuOn(1, "Close tabs to the left");
  await expect(tabs).toHaveCount(2);
  await expect(tabs.first()).toContainText("Weird");

  await menuOn(0, 'Close all tabs of "Shop"');
  await expect(tabs).toHaveCount(1);
  await expect(page.locator(".tab")).toContainText("Query 1");

  await page.keyboard.press("Control+t");
  await page.keyboard.press("Control+t");
  await menuOn(1, "Close others");
  await expect(tabs).toHaveCount(1);
  await expect(page.locator(".tab.active")).toContainText("Query");

  await page.keyboard.press("Control+t");
  await menuOn(0, "Close all");
  await expect(tabs).toHaveCount(0);
  await expect(page.locator(".welcome")).toBeVisible();
});

test("connections: edit and delete with confirmation", async ({ page }) => {
  await open(page);
  const row = page.locator(".tree-row", { hasText: "Shop" });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit connection" }).click();
  await page.locator(".field", { hasText: "Name" }).locator("input").fill("Shop renamed");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".tree-row", { hasText: "Shop renamed" })).toBeVisible();

  await page.locator(".tree-row", { hasText: "Shop renamed" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete connection" }).click();
  await expect(page.getByRole("dialog")).toContainText("system keychain");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".tree-empty")).toContainText("No connections yet");
  expect(await api("connections_list")).toEqual([]);
});
