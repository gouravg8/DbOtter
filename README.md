# DbOtter

A fast, keyboard-first database client for **PostgreSQL**, **MySQL / MariaDB** and
**SQLite**. **v0.0.1**

Tauri v2 + Rust backend, React + CodeMirror 6 frontend. It uses the operating system's own
webview instead of bundling Chromium, so the app is a single ~9 MB binary.

## Features (v0.0.1)

**Databases**
- PostgreSQL (10 and newer), MySQL / MariaDB, and SQLite files, all with the same features
  below: browsing, structure, the editor, per-tab sessions, limits, cancel and history
- Each MySQL database shows as a schema in the tree; a SQLite file shows `main` and any
  attached databases
- SQLite opens existing files only (a typo in the path never creates an empty database)

**Connections**
- Add, edit and delete connections, or paste a URL to fill the form: `postgres://…`,
  `mysql://…` / `mariadb://…` (`?sslmode=` or `?ssl-mode=`), `sqlite:///path/to/file.db`
  or just the path of a `.db` / `.sqlite` file
- Passwords live in the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service / GNOME Keyring on Linux), never in a file
- Not saving the password? You're asked when connecting, and it's kept in memory for the session only
- Test connection (server version and latency)
- SSL (Postgres and MySQL): disable, prefer, require (encrypt without checking the certificate, like libpq), verify-full (system roots, or your own CA file, plus the host name)
- A color per connection (e.g. red for production), shown in the sidebar, tabs and status bar

**Browse**
- Sidebar tree: schemas (MySQL: databases), then tables, views and materialized views, with row estimates; fuzzy search (`/`)
- Table data: pages of 100 rows by default (50 to 5,000 in Settings), sort by clicking a header, filters (column, operator, value) plus a raw `WHERE` condition, exact count on demand
- Structure: columns (type, nullable, default, primary key, comment), indexes with definitions and sizes, constraints, view definitions, table size

**Query**
- SQL editor: highlighting and keywords for the connection's dialect (PostgreSQL, MySQL, MariaDB, SQLite), autocomplete for schemas, tables and columns
- `Ctrl/⌘ Enter` runs the selection or the statement under the cursor; `Ctrl/⌘ Shift Enter` runs everything
- Several statements: one result per statement; row count and timing; errors show the database's message, detail, hint and code (SQLSTATE for Postgres), and underline the failing token
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
scripts/test-mysql.sh start         # throwaway MySQL / MariaDB on 127.0.0.1:33306
export DBOTTER_TEST_MYSQL_PORT=33306

pnpm test:unit                      # SQL splitter, themes, formats (node --test)
pnpm test:rust                      # Rust unit + integration tests against the test database
pnpm exec playwright install chromium
pnpm test:e2e                       # the real UI in Chromium + real backend via the bridge
scripts/test-db.sh stop; scripts/test-mysql.sh stop
```

SQLite needs no server: its tests make their own files. Without the environment variables,
the Postgres and MySQL tests are skipped.

Each engine has its own integration tests (`src-tauri/tests/postgres.rs`, `mysql.rs`,
`sqlite.rs`). They cover password prompts, the keychain (under a separate
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
  db.rs        open connections by id; dispatches to the engine, table paging and counts
  pg.rs        PostgreSQL engine (pools, per-tab sessions, TLS, introspection)
  mysql.rs     MySQL / MariaDB engine
  sqlite.rs    SQLite engine
  results.rs   collecting results: row and byte limits, cancel past the limit
  running.rs   queries in flight and how to cancel them on each engine
  sql.rs       SQL for table browsing per dialect (quoting, filters)
  store.rs     connections.json and history.jsonl
  secrets.rs   OS keychain
src/
  lib/         api client, app store, themes, SQL statement splitter, formatting
  components/  sidebar, tabs, SQL editor, data grid, dialogs, palette, settings
e2e/           Playwright tests
scripts/       test databases (Postgres, MySQL)
```

## Roadmap: v0.0.2

Goal: safe and practical on real production databases. v0.0.1 lets you look at data;
v0.0.2 lets you reach any database, change data safely, and get data out.

### Must-have

1. **SSH tunnels**: connect through a bastion host with a password, a key file or ssh-agent;
   `~/.ssh/config` host aliases and jump hosts (ProxyJump). Private RDS and most company
   databases are only reachable this way.
2. **Connection reliability**: keepalives and automatic reconnect for dropped idle
   connections (reads only are retried, never writes); a PgBouncer mode without prepared
   statements, so transaction poolers such as Supabase's port 6543 work; a clear "connection
   lost" state.
3. **Edit data with a review step**: edit cells, add and delete rows (tables with a primary
   key). Changes stay pending and highlighted until you review the generated SQL and commit
   them in one transaction; discard drops them all.
4. **Production safety**: read-only connections (refused in the app and opened as read-only
   transactions); for connections marked as production, a confirmation before `UPDATE` /
   `DELETE` without `WHERE`, `DROP` and `TRUNCATE`; the open-transaction state shown on the
   query tab with Commit / Rollback.
5. **Export to files**: save a result or a whole table as CSV, JSON or SQL `INSERT`s, streamed
   to disk so large exports never sit in memory.

### Should-have

6. **EXPLAIN view**: `EXPLAIN (ANALYZE)` as a readable plan tree with the slowest steps
   highlighted.
7. **JSONB viewer**: collapsible tree for json / jsonb values, with copy path.
8. **Saved queries**: named snippets per connection, available from the command palette.
9. **Editor comforts**: SQL formatter (`Ctrl/⌘ Shift F`), confirm before closing a query tab
   with unsaved SQL (outside vim mode), tab titles that follow the query's first table.

### Later

AI (plain English to SQL, explain a query), ER diagrams, schema diff, RDS IAM tokens and
client certificates, installers with auto-update and code signing for macOS and Windows.

### Done means

- Tested against a real hosted database (Neon or Supabase) and a Postgres behind an SSH
  tunnel, not only a local one.
- Every feature covered by integration and e2e tests, as in v0.0.1.
- Memory stays at or below ~250 MB in the same measurement as above.
