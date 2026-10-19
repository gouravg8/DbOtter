# DbOtter

A fast, keyboard-first PostgreSQL client. **v0.0.1**

Tauri v2 + Rust backend, React + CodeMirror 6 frontend. It uses the operating system's own
webview instead of bundling Chromium, so the app is a single ~9 MB binary.

## Features (v0.0.1)

**Connections**
- Add, edit and delete connections, or paste a `postgres://user:pass@host:5432/db?sslmode=…` URL to fill the form
- Passwords live in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service / GNOME Keyring on Linux), never in a file
- Not saving the password? You're asked when connecting, and it's kept in memory for the session only
- Test connection (server version and latency)
- SSL: disable, prefer, require (encrypt without checking the certificate, like libpq), verify-full (system roots, or your own CA file, plus the host name)
- A color per connection (e.g. red for production), shown in the sidebar, tabs and status bar

**Browse**
- Sidebar tree: schemas, then tables, views and materialized views, with row estimates; fuzzy search (`/`)
- Table data: pages of 50 to 5,000 rows, sort by clicking a header, filters (column, operator, value) plus a raw `WHERE` condition, exact count on demand
- Structure: columns (type, nullable, default, primary key, comment), indexes with definitions and sizes, constraints, view definitions, table size

**Query**
- SQL editor: Postgres highlighting, autocomplete for keywords, schemas, tables and columns
- `Ctrl/⌘ Enter` runs the selection or the statement under the cursor; `Ctrl/⌘ Shift Enter` runs everything
- Several statements: one result per statement; row count and timing; errors show the Postgres message, detail, hint and SQLSTATE, and underline the failing token
- Each query tab has its own database session: `BEGIN`, `UPDATE`, `COMMIT` run one at a time stay in one transaction, and `SET` or temp tables persist in that tab. Browsing tables uses a separate small pool, so an open transaction never leaks into it
- Results keep at most 5,000 rows (Settings) and 64 MB; the rest is read and dropped so the statement and the ones after it still finish. Queries can be cancelled at any point
- Query history, searchable, reopen any query in a new tab

**Grid** (results and tables)
- Only visible rows and columns are rendered, so large results scroll smoothly
- Cell, range and row selection; copy as TSV (pastes into spreadsheets), CSV or JSON; value viewer with pretty-printed JSON
- Resizable columns (double-click a header edge to fit); right-click a cell to filter by its value

**Look and keyboard**
- Themes: System (follows the OS), Otter Light / Dark, One Dark, Gruvbox Dark, Catppuccin Mocha / Latte, Nord
- Custom themes from a JSON file (Settings → Import theme); start from "Copy theme as JSON"
- Vim mode: full vim in the editor (lazy-loaded, ~120 KB only when enabled; `Ctrl W / R / B / E / F / G` belong to vim there, `:q` closes the tab), plus `h j k l`, `gg`, `G`, `0`, `$`, `y` / `Y`, `Ctrl d / u` in grids and `j k h l` in the sidebar
- Command palette, tabs, and shortcuts for everything

### Shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl/⌘ K` | Command palette (actions, connections, tables, themes) |
| `Ctrl/⌘ P` | Go to table |
| `Ctrl/⌘ T` / `Ctrl/⌘ W` | New query tab / close tab (`:q` in vim mode) |
| `Ctrl/⌘ Shift T` | Reopen the last closed tab |
| `Ctrl Tab`, `Ctrl/⌘ Shift ] [`, `Ctrl/⌘ 1…9` | Switch tabs |
| `Ctrl/⌘ Enter` / `Ctrl/⌘ Shift Enter` | Run statement or selection / run all |
| `Ctrl/⌘ R` | Refresh table (in a query tab: reload the schema for autocomplete) |
| `Ctrl/⌘ F` | Filter table rows |
| `[` `]` | Previous / next page |
| `Ctrl/⌘ B` | Toggle sidebar |
| `Ctrl/⌘ Shift E` / `Ctrl/⌘ E` | Focus sidebar / focus editor or grid |
| `Ctrl/⌘ Shift H` | Query history |
| `Ctrl/⌘ ,` | Settings |
| Grid: `Enter`, `Ctrl/⌘ C`, `Ctrl/⌘ A`, `Shift` + arrows | View value, copy, select all, extend selection |
| Sidebar: `/`, `Enter`, `s` | Search, open data, open structure |

### Custom theme format

```json
{
  "name": "Deep Sea",
  "appearance": "dark",
  "colors": { "surface": "#001122", "accent": "#00ccff" }
}
```

Colors you leave out come from Otter Light or Otter Dark. Available keys: `bg panel surface
elevated border fg muted subtle accent accentFg selection hover rowAlt danger warning success
null synKeyword synString synNumber synComment synFunction synOperator synType`.

## Memory

Measured on Linux (WebKitGTK 2.52, software rendering under Xvfb), proportional set size of all
app processes (Rust UI process + WebKit web and network processes):

| State | Memory |
| --- | --- |
| Started, one saved connection | ~179 MB |
| Connected, the 1M-row `orders` table open, and a 5,000-row query result | ~236 MB |

Most of it is the system webview. What keeps it bounded: results are capped (rows past the limit
are never fetched), tables are paged rather than loaded, the grid renders only what's in view,
and vim mode loads only when turned on.

## Develop

Requirements: Rust (stable), Node 20+, pnpm, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS (on Linux:
`libwebkit2gtk-4.1-dev`, `build-essential`, `libayatana-appindicator3-dev`, `librsvg2-dev`).

```bash
pnpm install
pnpm tauri dev                 # run the app
pnpm tauri build --no-bundle   # release binary: src-tauri/target/release/dbotter
pnpm tauri build               # installers (deb, rpm, AppImage / dmg / msi)
```

Data lives in the OS app-data folder (`~/.local/share/info.smoothops.dbotter` on Linux):
`connections.json` (no passwords) and `history.jsonl`. Settings, themes and open tabs are kept
in the webview's local storage.

### UI in a normal browser

The Rust side is reachable over HTTP through a dev-only bridge (`src-tauri/examples/bridge.rs`,
listens on 127.0.0.1 and answers only the dev UI's origin, not part of the app), handy for UI
work and browser tests:

```bash
pnpm bridge 1430 /tmp/dbotter-dev   # terminal 1
pnpm dev:browser                    # terminal 2, then open http://localhost:1420
```

## Tests

```bash
scripts/test-db.sh start            # throwaway Postgres on 127.0.0.1:55432 with seeded data
export DBOTTER_TEST_PORT=55432
export DBOTTER_TEST_CA=$PWD/.test-db/ca.crt   # TLS tests (the script enables TLS when openssl exists)

pnpm test:unit                      # SQL splitter, themes, formats (node --test)
pnpm test:rust                      # Rust unit + integration tests against the test database
pnpm exec playwright install chromium
pnpm test:e2e                       # the real UI in Chromium + real backend via the bridge
scripts/test-db.sh stop
```

The integration tests cover password prompts, the keychain (under a separate
"DbOtter (tests)" service, cleaned up afterwards), every SSL mode against a TLS server (including
verify-full with a custom CA), per-tab sessions and transactions, schema and structure
introspection (generated columns, partitioned tables), filters with quotes, wildcards and json,
awkward identifiers, multi-statement queries, error positions, row and byte limits on a 1M-row
table, cancelling and history. The e2e tests drive the UI end to end:
connection flow, browsing, grid keys and copy formats, queries, palette and sidebar keyboard
navigation, vim mode in the editor, themes (including custom import), restoring tabs after a
restart, sessions (disconnect, editing an open connection), and deleting connections.

## Project layout

```
src-tauri/src/
  api.rs       every command the UI can call (one dispatch entry point)
  db.rs        connection pools, queries, cancel, TLS, schema and structure introspection
  sql.rs       SQL for table browsing (quoting, filters)
  store.rs     connections.json and history.jsonl
  secrets.rs   OS keychain
src/
  lib/         api client, app store, themes, SQL statement splitter, formatting
  components/  sidebar, tabs, SQL editor, data grid, dialogs, palette, settings
e2e/           Playwright tests
scripts/       test database
```

## Next (v0.0.2 ideas)

SSH tunnels · inline cell editing with a review-before-commit step · save results to a file ·
`EXPLAIN` visualizer · JSONB viewer · more databases.
