//! Integration tests against real SQLite files, seeded here with rusqlite. Always run:
//!
//!   cargo test --test sqlite

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use dbotter_lib::api::App;
use dbotter_lib::secrets::Secrets;
use dbotter_lib::store::Store;
use serde_json::{Value, json};

const SEED: &str = r#"
CREATE TABLE customers(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  country TEXT,
  score REAL,
  avatar BLOB,
  created TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO customers(name, country, score, avatar) VALUES
  ('Ada', NULL, 1.5, x'DEAD01'),
  ('O''Brien "the 50%_off" guy', 'Ireland', 2.0, NULL),
  ('Bea "the 50 percent off" decoy', 'Brazil', NULL, NULL),
  ('Cy', 'Brazil', 0.1, NULL);

CREATE TABLE orders(
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  net REAL,
  tax REAL GENERATED ALWAYS AS (net * 0.2) VIRTUAL,
  total REAL AS (net + tax) STORED,
  note TEXT);
WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM g WHERE i < 50000)
INSERT INTO orders(id, customer_id, amount, net, note)
  SELECT i, 1 + i % 4, i % 1000 + 0.5, i, CASE WHEN i % 1000 = 0 THEN 'n' || i END FROM g;
CREATE INDEX orders_customer_idx ON orders(customer_id);
CREATE UNIQUE INDEX orders_note_uq ON orders(note) WHERE note IS NOT NULL;
CREATE VIEW big_orders AS SELECT id, amount FROM orders WHERE amount > 900;

CREATE TABLE "Weird ""Name"" Table"("Col A" TEXT, "select" TEXT, UNIQUE("Col A", "select"));
INSERT INTO "Weird ""Name"" Table" VALUES ('z', 'first'), ('a', 'reserved word column');

CREATE TABLE memberships(
  team TEXT,
  member INTEGER REFERENCES customers ON UPDATE CASCADE,
  role TEXT,
  PRIMARY KEY (team, member)) WITHOUT ROWID;
INSERT INTO memberships VALUES ('red', 2, 'lead'), ('blue', 3, NULL), ('blue', 1, 'dev'), ('red', 1, NULL);

-- no primary key: pages follow the rowid, which differs from `at` order
CREATE TABLE log(at TEXT, msg TEXT);
INSERT INTO log VALUES ('2', 'second'), ('1', 'first');

ANALYZE;
"#;

/// A fresh seeded database file.
fn seeded() -> PathBuf {
    let path = std::env::temp_dir().join(format!("dbotter-it-{}.sqlite", uuid::Uuid::new_v4()));
    rusqlite::Connection::open(&path).unwrap().execute_batch(SEED).unwrap();
    path
}

fn app() -> App {
    let dir = std::env::temp_dir().join(format!("dbotter-it-{}", uuid::Uuid::new_v4()));
    App::new(Store::new(dir).unwrap(), Secrets::new("DbOtter (tests)"))
}

async fn call(app: &App, cmd: &str, args: Value) -> Value {
    match app.dispatch(cmd, args).await {
        Ok(v) => v,
        Err(e) => panic!("{cmd} failed: {}", serde_json::to_string(&e).unwrap()),
    }
}

async fn call_err(app: &App, cmd: &str, args: Value) -> Value {
    match app.dispatch(cmd, args).await {
        Ok(v) => panic!("{cmd} should fail, got {v}"),
        Err(e) => serde_json::to_value(e).unwrap(),
    }
}

fn input(path: &str) -> Value {
    json!({ "input": { "kind": "sqlite", "name": "", "host": "", "port": 0, "database": path, "user": "",
                       "sslMode": "disable", "savePassword": false } })
}

/// Saves and connects a connection to `path`, returning its id.
async fn connected(app: &App, path: &Path) -> String {
    let conn = call(app, "connection_save", input(path.to_str().unwrap())).await;
    let id = conn["id"].as_str().unwrap().to_string();
    call(app, "connect", json!({ "id": id })).await;
    id
}

async fn run(app: &App, id: &str, sql: &str, max_rows: Option<usize>) -> Value {
    call(app, "run_query", json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "sql": sql, "maxRows": max_rows }))
        .await
}

/// Runs on a query tab's own connection.
async fn run_in(app: &App, id: &str, editor: &str, sql: &str) -> Value {
    call(app, "run_query", json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "sql": sql, "editor": editor })).await
}

async fn run_in_err(app: &App, id: &str, editor: &str, sql: &str) -> Value {
    call_err(app, "run_query", json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "sql": sql, "editor": editor }))
        .await
}

fn cell(out: &Value) -> Value {
    out["results"].as_array().unwrap().last().unwrap()["rows"][0][0].clone()
}

fn find<'a>(list: &'a Value, key: &str, value: &str) -> &'a Value {
    list.as_array().unwrap().iter().find(|v| v[key] == value).unwrap_or_else(|| panic!("no {key} = {value} in {list}"))
}

async fn page(app: &App, id: &str, query: Value) -> Value {
    call(app, "table_rows", json!({ "id": id, "queryId": "q", "query": query })).await
}

#[tokio::test]
async fn opens_existing_files_only() {
    let app = app();
    let missing = std::env::temp_dir().join(format!("dbotter-missing-{}.sqlite", uuid::Uuid::new_v4()));
    let missing = missing.to_str().unwrap();
    let err = call_err(&app, "connection_test", input(missing)).await;
    assert_eq!(err["code"], "not_found", "{err}");
    assert!(err["message"].as_str().unwrap().contains(missing), "{err}");
    let conn = call(&app, "connection_save", input(missing)).await;
    let err = call_err(&app, "connect", json!({ "id": conn["id"] })).await;
    assert_eq!(err["code"], "not_found", "{err}");
    assert!(!std::path::Path::new(missing).exists(), "a missing file must not be created");

    let path = seeded();
    let test = call(&app, "connection_test", input(path.to_str().unwrap())).await;
    assert_eq!(test["product"], "SQLite");
    assert!(test["serverVersion"].as_str().unwrap().starts_with("3."), "{test}");

    let conn = call(&app, "connection_save", input(path.to_str().unwrap())).await;
    assert_eq!(conn["name"], path.file_name().unwrap().to_str().unwrap(), "named after the file");
    let info = call(&app, "connect", json!({ "id": conn["id"] })).await;
    assert_eq!(info["kind"], "sqlite");
    assert_eq!(info["product"], "SQLite");
    assert_eq!(info["serverVersion"], test["serverVersion"]);
    assert_eq!(info["database"], path.to_str().unwrap());
    assert_eq!(info["user"], "");
    assert_eq!(info["defaultSchema"], "main");
}

#[tokio::test]
async fn schema_and_structure() {
    let app = app();
    let id = connected(&app, &seeded()).await;

    let tree = call(&app, "schema", json!({ "id": id })).await;
    let schemas = tree["schemas"].as_array().unwrap();
    assert_eq!(schemas.len(), 1);
    assert_eq!(schemas[0]["name"], "main");
    let rels = &schemas[0]["relations"];
    let names: Vec<&str> = rels.as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["Weird \"Name\" Table", "big_orders", "customers", "log", "memberships", "orders"]);
    assert_eq!(find(rels, "name", "big_orders")["kind"], "view");
    let orders = find(rels, "name", "orders");
    assert_eq!(orders["kind"], "table");
    assert_eq!(orders["estimatedRows"], -1);
    assert_eq!(orders["columns"][2], json!({ "name": "amount", "dataType": "REAL" }));
    assert_eq!(orders["columns"][4]["name"], "tax", "generated columns are listed too");

    let s = call(&app, "table_structure", json!({ "id": id, "schema": "main", "table": "orders" })).await;
    let cols = &s["columns"];
    assert_eq!(cols[0]["name"], "id");
    assert_eq!(cols[0]["primaryKey"], true);
    assert_eq!(cols[0]["nullable"], false, "INTEGER PRIMARY KEY is the rowid");
    assert_eq!(cols[1]["nullable"], false);
    assert_eq!(cols[3]["nullable"], true);
    assert_eq!(find(cols, "name", "tax")["generated"], "GENERATED ALWAYS AS (net * 0.2) VIRTUAL");
    assert_eq!(find(cols, "name", "total")["generated"], "GENERATED ALWAYS AS (net + tax) STORED");
    assert!(find(cols, "name", "total")["default"].is_null());
    assert!(find(cols, "name", "note")["generated"].is_null());
    assert!(s["definition"].as_str().unwrap().starts_with("CREATE TABLE orders("), "{}", s["definition"]);
    assert!(s["comment"].is_null());
    let size = s["totalSize"].as_str().unwrap();
    assert!(size.ends_with("kB") || size.ends_with("MB"), "{size}");

    let idx = &s["indexes"];
    assert_eq!(find(idx, "name", "orders_customer_idx")["definition"], "CREATE INDEX orders_customer_idx ON orders(customer_id)");
    assert_eq!(find(idx, "name", "orders_customer_idx")["unique"], false);
    let uq = find(idx, "name", "orders_note_uq");
    assert_eq!(uq["unique"], true);
    assert!(uq["definition"].as_str().unwrap().ends_with("WHERE note IS NOT NULL"), "{uq}");
    let kinds: Vec<&str> = s["constraints"].as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["primary key", "foreign key"]);
    assert_eq!(s["constraints"][0]["definition"], "PRIMARY KEY (id)");
    assert_eq!(s["constraints"][1]["definition"], "FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE");
    assert_eq!(s["constraints"][1]["name"], "customer_id");

    let c = call(&app, "table_structure", json!({ "id": id, "schema": "main", "table": "customers" })).await;
    assert_eq!(find(&c["columns"], "name", "created")["default"], "CURRENT_TIMESTAMP");
    assert_eq!(find(&c["columns"], "name", "avatar")["dataType"], "BLOB");
    assert_eq!(c["indexes"], json!([]), "the rowid key has no index");

    // WITHOUT ROWID with a composite key: its key is an index, its columns are NOT NULL
    let m = call(&app, "table_structure", json!({ "id": id, "schema": "main", "table": "memberships" })).await;
    let cols = &m["columns"];
    assert_eq!((cols[0]["primaryKey"].clone(), cols[1]["primaryKey"].clone(), cols[2]["primaryKey"].clone()), (json!(true), json!(true), json!(false)));
    assert_eq!(cols[0]["nullable"], false);
    assert_eq!(cols[2]["nullable"], true);
    assert_eq!(m["indexes"][0]["primary"], true);
    assert_eq!(m["indexes"][0]["unique"], true);
    assert_eq!(m["indexes"][0]["definition"], "PRIMARY KEY (team, member)");
    assert_eq!(m["constraints"][0]["definition"], "PRIMARY KEY (team, member)");
    assert_eq!(m["constraints"][1]["definition"], "FOREIGN KEY (member) REFERENCES customers ON UPDATE CASCADE");
    assert!(m["definition"].as_str().unwrap().ends_with("WITHOUT ROWID"));

    // UNIQUE table constraint, identifiers that need quoting
    let w = call(&app, "table_structure", json!({ "id": id, "schema": "main", "table": "Weird \"Name\" Table" })).await;
    assert_eq!(w["constraints"], json!([{ "name": "Col A, select", "kind": "unique", "definition": "UNIQUE (\"Col A\", \"select\")" }]));
    assert_eq!(w["indexes"][0]["unique"], true);
    assert_eq!(w["indexes"][0]["primary"], false);
    assert!(w["indexes"][0]["name"].as_str().unwrap().starts_with("sqlite_autoindex_"));

    let v = call(&app, "table_structure", json!({ "id": id, "schema": "main", "table": "big_orders" })).await;
    assert!(v["definition"].as_str().unwrap().contains("amount > 900"));
    assert!(v["totalSize"].is_null());
    assert_eq!(v["indexes"], json!([]));
    assert_eq!(v["columns"][1]["name"], "amount");

    for (schema, table) in [("main", "nope"), ("nope", "orders")] {
        let err = call_err(&app, "table_structure", json!({ "id": id, "schema": schema, "table": table })).await;
        assert_eq!(err["code"], "not_found", "{err}");
    }
}

#[tokio::test]
async fn table_rows_filters_and_sort() {
    let app = app();
    let id = connected(&app, &seeded()).await;

    let p = page(&app, &id, json!({ "schema": "main", "table": "orders", "limit": 100, "offset": 0 })).await;
    assert_eq!(p["result"]["rows"].as_array().unwrap().len(), 100);
    assert_eq!(p["result"]["truncated"], false);
    assert_eq!(p["result"]["columns"], json!(["id", "customer_id", "amount", "net", "tax", "total", "note"]));

    let p = page(&app, &id, json!({ "schema": "main", "table": "orders", "limit": 5, "offset": 10,
                                    "sort": { "column": "amount", "desc": true } }))
    .await;
    let amounts: Vec<f64> =
        p["result"]["rows"].as_array().unwrap().iter().map(|r| r[2].as_str().unwrap().parse().unwrap()).collect();
    assert_eq!(amounts.len(), 5);
    assert!(amounts.windows(2).all(|w| w[0] >= w[1]));
    assert!(p["sql"].as_str().unwrap().ends_with("ORDER BY \"amount\" DESC LIMIT 5 OFFSET 10"));

    // LIKE wildcards and quotes in the value match literally
    let p = page(&app, &id, json!({ "schema": "main", "table": "customers", "limit": 50, "offset": 0,
                                    "filters": [{ "column": "name", "op": "contains", "value": "\"the 50%_off\"" }] }))
    .await;
    let rows = p["result"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][1], "O'Brien \"the 50%_off\" guy");

    let filters = json!([{ "column": "country", "op": "=", "value": "Brazil" }]);
    let q = json!({ "schema": "main", "table": "customers", "limit": 50, "offset": 0, "filters": filters });
    let p = page(&app, &id, q.clone()).await;
    let ids: Vec<&str> = p["result"]["rows"].as_array().unwrap().iter().map(|r| r[0].as_str().unwrap()).collect();
    assert_eq!(ids, ["3", "4"]);
    assert_eq!(call(&app, "table_count", json!({ "id": id, "queryId": "c", "query": q })).await, 2);

    // NULL as null, blob as hex, REAL as SQLite prints it
    let q = json!({ "schema": "main", "table": "customers", "limit": 50, "offset": 0,
                    "filters": [{ "column": "country", "op": "is null" }] });
    let p = page(&app, &id, q).await;
    let ada = &p["result"]["rows"][0];
    assert_eq!(ada[1], "Ada");
    assert!(ada[2].is_null());
    assert_eq!(ada[3], "1.5");
    assert_eq!(ada[4], "\\xdead01");
    let p = page(&app, &id, json!({ "schema": "main", "table": "customers", "limit": 50, "offset": 0, "whereRaw": "id = 2" })).await;
    assert_eq!(p["result"]["rows"][0][3], "2.0");

    // filters and the raw WHERE together; count agrees with the page
    let q = json!({ "schema": "main", "table": "orders", "limit": 1000, "offset": 0, "whereRaw": "id < 2000",
                    "filters": [{ "column": "note", "op": "is not null" }, { "column": "customer_id", "op": "=", "value": "1" }] });
    let p = page(&app, &id, q.clone()).await;
    let row = p["result"]["rows"][0].as_array().unwrap();
    assert_eq!(row[..4], [json!("1000"), json!("1"), json!("0.5"), json!("1000.0")]);
    // the virtual REAL column comes back as 200.0 or, through the sorter, as the integer 200:
    // SQLite's own value either way
    assert!(row[4] == "200.0" || row[4] == "200", "{}", row[4]);
    assert_eq!(row[5..], [json!("1200.0"), json!("n1000")]);
    assert_eq!(p["result"]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(call(&app, "table_count", json!({ "id": id, "queryId": "c", "query": q })).await, 1);
    let all = json!({ "schema": "main", "table": "orders", "limit": 1, "offset": 0 });
    assert_eq!(call(&app, "table_count", json!({ "id": id, "queryId": "c", "query": all })).await, 50_000);

    // identifiers needing quotes
    let p = page(&app, &id, json!({ "schema": "main", "table": "Weird \"Name\" Table", "limit": 10, "offset": 0,
                                    "sort": { "column": "select", "desc": false } }))
    .await;
    assert_eq!(p["result"]["columns"], json!(["Col A", "select"]));
    assert_eq!(p["result"]["rows"][1], json!(["a", "reserved word column"]));

    let err = call_err(&app, "table_rows", json!({ "id": id, "queryId": "q",
        "query": { "schema": "main", "table": "customers", "limit": 10, "offset": 0, "whereRaw": "nope = 1" } }))
    .await;
    assert!(err["message"].as_str().unwrap().contains("no such column: nope"), "{err}");

    // the raw WHERE can't add statements, whatever the quoting tricks
    let raw = |w: &str| json!({ "id": id, "queryId": "q",
        "query": { "schema": "main", "table": "customers", "limit": 10, "offset": 0, "whereRaw": w } });
    for evil in ["1); DELETE FROM customers; SELECT (1", "1) /* ' */; DELETE FROM customers; SELECT * FROM customers WHERE (1 /* ' */"] {
        let err = call_err(&app, "table_rows", raw(evil)).await;
        assert!(err["message"].as_str().unwrap().contains("several statements"), "{err}");
        let err = call_err(&app, "table_count", raw(evil)).await;
        assert!(err["message"].as_str().unwrap().contains("several statements"), "{err}");
    }
    assert_eq!(cell(&run(&app, &id, "SELECT count(*) FROM customers", None).await), "4");
    // semicolons inside literals and comments are fine
    // (double quotes are names here: the browse connection turns SQLite's legacy fallback of
    // unknown "names" to strings off)
    for ok in ["name <> 'a;b'", "name <> 'x;y' -- a; comment", "\"name\" <> 'x;' /* ; */"] {
        let page = call(&app, "table_rows", raw(ok)).await;
        assert_eq!(page["result"]["rows"].as_array().unwrap().len(), 4, "{ok}");
    }
}

#[tokio::test]
async fn queries_errors_limits_cancel() {
    let app = app();
    let id = connected(&app, &seeded()).await;

    // several statements: one result per statement
    let out = run(&app, &id, "CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1),(2),(3); SELECT x, x * 2 AS y FROM t ORDER BY x;
                              SELECT 'a' WHERE 0; UPDATE t SET x = x WHERE x > 1 RETURNING x; DROP TABLE t", None).await;
    let results = out["results"].as_array().unwrap();
    assert_eq!(results.len(), 6);
    assert_eq!(results[0]["hasRows"], false);
    assert_eq!(results[0]["rowCount"], 0);
    assert_eq!(results[1]["rowCount"], 3);
    assert_eq!(results[2]["columns"], json!(["x", "y"]));
    assert_eq!(results[2]["rows"], json!([["1", "2"], ["2", "4"], ["3", "6"]]));
    assert_eq!(results[3]["hasRows"], true);
    assert_eq!(results[3]["rows"], json!([]));
    assert_eq!(results[4]["rows"], json!([["2"], ["3"]]));
    assert_eq!(results[4]["rowCount"], 2);
    assert_eq!(results[5]["hasRows"], false);
    assert_eq!(results[5]["rowCount"], 0, "not the UPDATE's count");

    // values as SQLite itself prints them
    let out = run(&app, &id, "SELECT v, CAST(v AS TEXT), typeof(v) FROM (SELECT 1.0 AS v UNION ALL SELECT 0.1 + 0.2
              UNION ALL SELECT 1e20 UNION ALL SELECT 1.0 / 3 UNION ALL SELECT -2.5e-7 UNION ALL SELECT 9e999
              UNION ALL SELECT 123456789012.25 UNION ALL SELECT 9223372036854775807 UNION ALL SELECT 'text')", None).await;
    for row in out["results"][0]["rows"].as_array().unwrap() {
        assert_eq!(row[0], row[1], "{row}");
    }
    assert_eq!(cell(&run(&app, &id, "SELECT x'00ff', NULL", None).await), "\\x00ff");

    // errors: SQLite's message, extended code name, position of the bad token
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "e", "sql": "SELECT id, nam FROM customers" })).await;
    assert_eq!(err["message"], "no such column: nam");
    assert_eq!(err["code"], "SQLITE_ERROR");
    assert_eq!(err["position"], 12);
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "e", "sql": "SELECT 1; SELECT nope FROM customers" })).await;
    assert_eq!(err["position"], 18, "counted from the start of the whole text");
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "e", "sql": "INSERT INTO customers(id, name) VALUES (1, 'x')" })).await;
    assert_eq!(err["code"], "SQLITE_CONSTRAINT_PRIMARYKEY", "{err}");
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "e", "sql": "SELEC 1" })).await;
    assert!(err["message"].as_str().unwrap().contains("syntax error"), "{err}");

    // row limit: keeps 1,000 rows, reports the full count, and the statement after it runs
    let out = run(&app, &id, "SELECT * FROM orders; SELECT 'after'", Some(1000)).await;
    let r = &out["results"][0];
    assert_eq!(r["truncated"], true);
    assert_eq!(r["rows"].as_array().unwrap().len(), 1000);
    assert_eq!(r["rowCount"], 50_000);
    assert_eq!(out["results"][1]["rows"], json!([["after"]]));

    // cancel an endless query from another task
    let app = std::sync::Arc::new(app);
    let (a, i) = (app.clone(), id.clone());
    let endless = "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT count(*) FROM r";
    let running = tokio::spawn(async move { a.dispatch("run_query", json!({ "id": i, "queryId": "slow", "sql": endless })).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = Instant::now();
    assert_eq!(call(&app, "cancel_query", json!({ "queryId": "slow" })).await, true);
    let err = serde_json::to_value(running.await.unwrap().unwrap_err()).unwrap();
    assert_eq!(err["code"], "57014", "{err}");
    assert!(started.elapsed() < Duration::from_secs(2), "took {:?}", started.elapsed());
    assert_eq!(call(&app, "cancel_query", json!({ "queryId": "slow" })).await, false);
    // the interrupt doesn't linger on the connection
    assert_eq!(cell(&run(&app, &id, "SELECT 1", None).await), "1");

    // cancelled while rows past the limit are being skipped: the kept rows come back, flagged
    let (a, i) = (app.clone(), id.clone());
    let endless = "WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r) SELECT i FROM r";
    let big = tokio::spawn(async move {
        a.dispatch("run_query", json!({ "id": i, "queryId": "big", "sql": endless, "maxRows": 10 })).await
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(call(&app, "cancel_query", json!({ "queryId": "big" })).await, true);
    let out = big.await.unwrap().unwrap();
    assert_eq!(out["canceled"], true);
    assert_eq!(out["results"][0]["rows"].as_array().unwrap().len(), 10);
}

#[tokio::test]
async fn query_tabs_keep_their_own_session() {
    let app = app();
    let id = connected(&app, &seeded()).await;
    let count = "SELECT count(*) FROM log";
    let browse_count = || async {
        let q = json!({ "schema": "main", "table": "log", "limit": 1, "offset": 0 });
        call(&app, "table_count", json!({ "id": id, "queryId": "c", "query": q })).await
    };

    // a transaction run one statement at a time stays on the tab's connection
    run_in(&app, &id, "tab-a", "BEGIN").await;
    run_in(&app, &id, "tab-a", "INSERT INTO log VALUES ('3', 'from tab a')").await;
    assert_eq!(cell(&run_in(&app, &id, "tab-a", count).await), "3");
    // other tabs and browsing don't see it until COMMIT
    assert_eq!(cell(&run_in(&app, &id, "tab-b", count).await), "2");
    assert_eq!(browse_count().await, 2);
    run_in(&app, &id, "tab-a", "COMMIT").await;
    assert_eq!(cell(&run_in(&app, &id, "tab-b", count).await), "3");
    assert_eq!(browse_count().await, 3);

    // temp tables belong to the tab's connection
    run_in(&app, &id, "tab-a", "CREATE TEMP TABLE scratch(x)").await;
    run_in(&app, &id, "tab-a", "SELECT * FROM scratch").await;
    let err = run_in_err(&app, &id, "tab-b", "SELECT * FROM scratch").await;
    assert_eq!(err["message"], "no such table: scratch");

    // closing the tab closes its connection, rolling back what it left open
    run_in(&app, &id, "tab-a", "BEGIN").await;
    run_in(&app, &id, "tab-a", "INSERT INTO log VALUES ('4', 'never committed')").await;
    call(&app, "editor_release", json!({ "editor": "tab-a" })).await;
    assert_eq!(cell(&run_in(&app, &id, "tab-b", count).await), "3");
    run_in(&app, &id, "tab-b", "INSERT INTO log VALUES ('4', 'tab b can write')").await;
    assert_eq!(cell(&run_in(&app, &id, "tab-a", count).await), "4");
    let err = run_in_err(&app, &id, "tab-a", "SELECT * FROM scratch").await;
    assert_eq!(err["message"], "no such table: scratch", "a new connection for the tab");
}

#[tokio::test]
async fn stable_paging_by_primary_key() {
    let app = app();
    let id = connected(&app, &seeded()).await;
    let first_page = |table: &str| json!({ "schema": "main", "table": table, "limit": 10, "offset": 0 });

    // no sort chosen: pages follow the primary key
    let p = page(&app, &id, json!({ "schema": "main", "table": "orders", "limit": 3, "offset": 3 })).await;
    assert!(p["sql"].as_str().unwrap().contains("ORDER BY \"id\" LIMIT"), "{}", p["sql"]);
    assert_eq!(p["result"]["rows"][0][0], "4");

    let p = page(&app, &id, first_page("memberships")).await;
    assert!(p["sql"].as_str().unwrap().contains("ORDER BY \"team\", \"member\""), "{}", p["sql"]);
    let keys: Vec<(String, String)> = p["result"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r[0].as_str().unwrap().into(), r[1].as_str().unwrap().into()))
        .collect();
    let want = [("blue", "1"), ("blue", "3"), ("red", "1"), ("red", "2")];
    assert_eq!(keys, want.map(|(a, b)| (a.to_string(), b.to_string())));

    // no primary key: the rowid, so pages are stable anyway
    let p = page(&app, &id, first_page("log")).await;
    assert!(p["sql"].as_str().unwrap().contains("ORDER BY \"rowid\""), "{}", p["sql"]);
    assert_eq!(p["result"]["rows"], json!([["2", "second"], ["1", "first"]]));
    let p = page(&app, &id, first_page("Weird \"Name\" Table")).await;
    assert_eq!(p["result"]["rows"][0], json!(["z", "first"]));

    // a column named rowid takes that name: the next alias
    run(&app, &id, "CREATE TABLE shadow(rowid TEXT, v TEXT); INSERT INTO shadow VALUES ('b', 'one'), ('a', 'two')", None).await;
    let p = page(&app, &id, first_page("shadow")).await;
    assert!(p["sql"].as_str().unwrap().contains("ORDER BY \"_rowid_\""), "{}", p["sql"]);
    assert_eq!(p["result"]["rows"][0], json!(["b", "one"]));

    // views have no key
    let p = page(&app, &id, first_page("big_orders")).await;
    assert!(!p["sql"].as_str().unwrap().contains("ORDER BY"), "{}", p["sql"]);

    // a primary key renamed behind the app's back: paging recovers instead of failing
    run(&app, &id, "CREATE TABLE pk_t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO pk_t VALUES (1, 'a'), (2, 'b')", None).await;
    let p = page(&app, &id, first_page("pk_t")).await;
    assert!(p["sql"].as_str().unwrap().contains("ORDER BY \"id\""));
    run(&app, &id, "ALTER TABLE pk_t RENAME COLUMN id TO uid", None).await;
    let p = page(&app, &id, first_page("pk_t")).await;
    assert!(p["sql"].as_str().unwrap().contains("ORDER BY \"uid\""), "{}", p["sql"]);
    assert_eq!(p["result"]["rows"].as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn read_only_connections() {
    let app = app();
    let path = seeded();
    let conn = call(&app, "connection_save", json!({ "input": { "kind": "sqlite", "name": "", "host": "", "port": 0,
        "database": path.display().to_string(), "user": "", "sslMode": "disable", "savePassword": false, "readOnly": true } })).await;
    let id = conn["id"].as_str().unwrap().to_string();
    assert_eq!(call(&app, "connect", json!({ "id": id })).await["readOnly"], true);
    assert_eq!(cell(&run(&app, &id, "SELECT count(*) FROM customers", None).await), "4");
    for (sql, editor) in [("DELETE FROM customers", None), ("CREATE TABLE nope (a)", Some("tab"))] {
        let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "w", "sql": sql, "editor": editor })).await;
        assert_eq!(err["code"], "SQLITE_READONLY", "{sql}: {err}");
    }
    assert_eq!(cell(&run(&app, &id, "SELECT count(*) FROM customers", None).await), "4");
}

/// The state of tab "t1"'s own session.
async fn tx(app: &App, id: &str) -> Value {
    call(app, "transaction_status", json!({ "id": id, "editor": "t1" })).await
}

#[tokio::test]
async fn transaction_status_of_a_tab() {
    let app = app();
    let id = connected(&app, &seeded()).await;
    assert_eq!(tx(&app, &id).await, "none");
    run_in(&app, &id, "t1", "SELECT 1").await;
    assert_eq!(tx(&app, &id).await, "idle");
    run_in(&app, &id, "t1", "BEGIN").await;
    assert_eq!(tx(&app, &id).await, "open");
    run_in(&app, &id, "t1", "ROLLBACK").await;
    assert_eq!(tx(&app, &id).await, "idle");
}
