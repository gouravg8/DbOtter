//! Integration tests against a real MySQL or MariaDB. Skipped unless DBOTTER_TEST_MYSQL_PORT
//! is set; scripts/test-mysql.sh starts a suitable server (root without a password, and
//! otter / otter-pass). Each test builds the databases it needs.
//!
//!   DBOTTER_TEST_MYSQL_PORT=33306 cargo test --test mysql

use std::time::{Duration, Instant};

use dbotter_lib::api::App;
use dbotter_lib::secrets::Secrets;
use dbotter_lib::store::Store;
use serde_json::{Value, json};

fn port() -> Option<u16> {
    std::env::var("DBOTTER_TEST_MYSQL_PORT").ok().and_then(|p| p.parse().ok())
}

fn app() -> App {
    let dir = std::env::temp_dir().join(format!("dbotter-my-{}", uuid::Uuid::new_v4()));
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

fn input(port: u16, user: &str, database: &str, ssl: &str) -> Value {
    json!({ "input": { "kind": "mysql", "name": "my", "host": "127.0.0.1", "port": port, "database": database,
                       "user": user, "sslMode": ssl, "savePassword": false } })
}

/// A saved, connected root connection to `database` (may be empty).
async fn connected(app: &App, port: u16, database: &str) -> String {
    let conn = call(app, "connection_save", input(port, "root", database, "prefer")).await;
    let id = conn["id"].as_str().unwrap().to_string();
    call(app, "connect", json!({ "id": id })).await;
    id
}

async fn run(app: &App, id: &str, sql: &str, max_rows: Option<usize>) -> Value {
    call(app, "run_query", json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "sql": sql, "maxRows": max_rows }))
        .await
}

async fn run_in(app: &App, id: &str, editor: &str, sql: &str) -> Value {
    call(app, "run_query", json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "sql": sql, "editor": editor })).await
}

fn cell(out: &Value) -> Value {
    out["results"].as_array().unwrap().last().unwrap()["rows"][0][0].clone()
}

/// A fresh database `name` with the shop tables (orders: 100,000 rows).
async fn shop(app: &App, id: &str, name: &str) {
    let sql = format!(
        "DROP DATABASE IF EXISTS {name}; CREATE DATABASE {name}; USE {name};
         CREATE TABLE customers (
           id INT AUTO_INCREMENT PRIMARY KEY,
           name VARCHAR(80) NOT NULL,
           email VARCHAR(120) UNIQUE,
           country VARCHAR(40) DEFAULT 'India',
           meta JSON,
           avatar BLOB,
           flags BIT(3),
           created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
         ) COMMENT 'People who bought something';
         INSERT INTO customers (name, email, country, meta, avatar, flags) VALUES
           ('Ada', 'ada@example.com', NULL, '{{\"plan\": \"pro\"}}', X'DEAD01', b'101'),
           ('O''Brien \"the 50%_off\" guy', 'ob@example.com', 'Ireland', NULL, NULL, NULL),
           ('Grace', NULL, 'USA', NULL, NULL, b'1');
         CREATE TABLE orders (
           id BIGINT AUTO_INCREMENT PRIMARY KEY,
           customer_id INT NOT NULL,
           amount DECIMAL(10, 2) NOT NULL,
           vat DECIMAL(10, 2) AS (amount * 0.2) STORED,
           status VARCHAR(20) NOT NULL DEFAULT 'new',
           note TEXT,
           CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
           CONSTRAINT amount_positive CHECK (amount >= 0),
           KEY orders_status_idx (status, customer_id DESC)
         );
         INSERT INTO orders (customer_id, amount, status, note)
           SELECT 1 + n % 3, (n % 1000) / 4, ELT(1 + n % 4, 'new', 'paid', 'shipped', 'done'),
                  IF(n % 1000 = 0, CONCAT('note ', n), NULL)
           FROM (SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 1 AS n
                 FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a,
                      (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b,
                      (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c,
                      (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e,
                      (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
                       UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) f) g
           ORDER BY n;
         CREATE VIEW big_orders AS SELECT id, amount FROM orders WHERE amount > 200;
         CREATE TABLE `we``ird` (`Col A` INT, `select` TEXT);
         INSERT INTO `we``ird` VALUES (1, 'reserved word column');
         ANALYZE TABLE customers, orders;"
    );
    run(app, id, &sql, None).await;
}

#[tokio::test]
async fn password_flow() {
    let Some(port) = port() else { return };
    let app = app();
    let conn = call(&app, "connection_save", input(port, "otter", "", "prefer")).await;
    let id = conn["id"].as_str().unwrap();

    let err = call_err(&app, "connect", json!({ "id": id })).await;
    assert_eq!(err["code"], "password_required", "{err}");
    assert_eq!(err["message"], "Password required");
    let err = call_err(&app, "connect", json!({ "id": id, "password": "nope" })).await;
    assert_eq!(err["code"], "password_required");
    assert!(err["message"].as_str().unwrap().contains("Access denied"), "{err}");

    let info = call(&app, "connect", json!({ "id": id, "password": "otter-pass" })).await;
    assert_eq!(info["kind"], "mysql");
    assert!(matches!(info["product"].as_str(), Some("MySQL" | "MariaDB")));
    assert_eq!(info["user"], "otter");
    assert_eq!(info["defaultSchema"], "");

    let test = call(&app, "connection_test", input(port, "root", "", "disable")).await;
    assert!(test["serverVersion"].as_str().unwrap().starts_with(|c: char| c.is_ascii_digit()));
    let err = call_err(&app, "connection_test", input(1, "root", "", "disable")).await;
    assert!(err["message"].as_str().unwrap().to_lowercase().contains("refused"), "{err}");
}

#[tokio::test]
async fn tls_modes() {
    let Some(port) = port() else { return };
    let app = app();
    for (mode, encrypted) in [("disable", false), ("prefer", true), ("require", true)] {
        let conn = call(&app, "connection_save", input(port, "root", "", mode)).await;
        let id = conn["id"].as_str().unwrap().to_string();
        call(&app, "connect", json!({ "id": id })).await;
        let out = run(&app, &id, "SHOW SESSION STATUS LIKE 'Ssl_cipher'", None).await;
        let cipher = out["results"][0]["rows"][0][1].as_str().unwrap_or("").to_string();
        assert_eq!(!cipher.is_empty(), encrypted, "{mode}: {cipher:?}");
    }
    // the server's own certificate is self-signed: verify-full must refuse it
    let err = call_err(&app, "connection_test", input(port, "root", "", "verify-full")).await;
    assert!(err["message"].as_str().unwrap().to_lowercase().contains("certificate"), "{err}");
}

#[tokio::test]
async fn schema_and_structure() {
    let Some(port) = port() else { return };
    let app = app();
    let root = connected(&app, port, "").await;
    shop(&app, &root, "otter_shop").await;
    let id = connected(&app, port, "otter_shop").await;

    let tree = call(&app, "schema", json!({ "id": id })).await;
    let schemas: Vec<&str> = tree["schemas"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(schemas[0], "otter_shop", "the connection's database first");
    assert!(!schemas.iter().any(|s| ["mysql", "sys", "information_schema", "performance_schema"].contains(s)));
    let shop = tree["schemas"].as_array().unwrap().iter().find(|s| s["name"] == "otter_shop").unwrap();
    let kinds: Vec<(&str, &str)> = shop["relations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["name"].as_str().unwrap(), r["kind"].as_str().unwrap()))
        .collect();
    assert!(kinds.contains(&("orders", "table")) && kinds.contains(&("big_orders", "view")) && kinds.contains(&("we`ird", "table")));
    let orders = shop["relations"].as_array().unwrap().iter().find(|r| r["name"] == "orders").unwrap();
    assert!(orders["estimatedRows"].as_i64().unwrap() > 50_000, "{}", orders["estimatedRows"]);
    assert_eq!(orders["columns"][2]["dataType"], "decimal(10,2)");

    let s = call(&app, "table_structure", json!({ "id": id, "schema": "otter_shop", "table": "customers" })).await;
    assert_eq!(s["comment"], "People who bought something");
    let col = |name: &str| s["columns"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone();
    assert_eq!(col("id")["primaryKey"], true);
    assert_eq!(col("id")["generated"], "AUTO_INCREMENT");
    assert_eq!(col("name")["nullable"], false);
    assert_eq!(col("country")["default"], "'India'");
    assert_eq!(col("created_at")["default"], "CURRENT_TIMESTAMP");
    assert!(s["indexes"].as_array().unwrap().iter().any(|i| i["primary"] == true));
    assert!(s["totalSize"].as_str().unwrap().contains("kB") || s["totalSize"].as_str().unwrap().contains("bytes"));

    let o = call(&app, "table_structure", json!({ "id": id, "schema": "otter_shop", "table": "orders" })).await;
    let vat = o["columns"].as_array().unwrap().iter().find(|c| c["name"] == "vat").unwrap();
    assert!(vat["generated"].as_str().unwrap().starts_with("GENERATED ALWAYS AS (") && vat["generated"].as_str().unwrap().ends_with("STORED"));
    let cons = o["constraints"].as_array().unwrap();
    assert_eq!(cons[0]["kind"], "primary key");
    let fk = cons.iter().find(|c| c["kind"] == "foreign key").unwrap();
    assert_eq!(fk["definition"], "FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE");
    assert!(cons.iter().any(|c| c["kind"] == "check" && c["name"] == "amount_positive"));
    let idx = o["indexes"].as_array().unwrap().iter().find(|i| i["name"] == "orders_status_idx").unwrap();
    assert_eq!(idx["definition"], "CREATE INDEX `orders_status_idx` ON `otter_shop`.`orders` (`status`, `customer_id` DESC) USING BTREE");

    let v = call(&app, "table_structure", json!({ "id": id, "schema": "otter_shop", "table": "big_orders" })).await;
    assert!(v["definition"].as_str().unwrap().contains("200"));
    assert!(v["totalSize"].is_null());
    let err = call_err(&app, "table_structure", json!({ "id": id, "schema": "otter_shop", "table": "nope" })).await;
    assert_eq!(err["code"], "not_found");
}

#[tokio::test]
async fn table_rows_filters_and_sort() {
    let Some(port) = port() else { return };
    let app = app();
    let root = connected(&app, port, "").await;
    shop(&app, &root, "otter_rows").await;
    let id = connected(&app, port, "otter_rows").await;
    let page = |q: Value| {
        let (app, id) = (&app, id.clone());
        async move { call(app, "table_rows", json!({ "id": id, "queryId": "q", "query": q })).await }
    };
    let count = |q: Value| {
        let (app, id) = (&app, id.clone());
        async move { call(app, "table_count", json!({ "id": id, "queryId": "c", "query": q })).await }
    };

    // no sort: ordered by the primary key
    let p = page(json!({ "schema": "otter_rows", "table": "orders", "limit": 3, "offset": 3 })).await;
    assert!(p["sql"].as_str().unwrap().contains("ORDER BY `id`"), "{}", p["sql"]);
    assert_eq!(p["result"]["rows"][0][0], "4");

    let p = page(json!({ "schema": "otter_rows", "table": "orders", "limit": 5, "offset": 0, "sort": { "column": "amount", "desc": true } })).await;
    let amounts: Vec<f64> = p["result"]["rows"].as_array().unwrap().iter().map(|r| r[2].as_str().unwrap().parse().unwrap()).collect();
    assert!(amounts.windows(2).all(|w| w[0] >= w[1]));

    // quotes and LIKE wildcards in the value match literally
    let q = json!({ "schema": "otter_rows", "table": "customers", "limit": 10, "offset": 0,
                    "filters": [{ "column": "name", "op": "contains", "value": "\"the 50%_off\"" }] });
    let p = page(q.clone()).await;
    assert_eq!(p["result"]["rows"].as_array().unwrap().len(), 1);
    assert_eq!(p["result"]["rows"][0][1], "O'Brien \"the 50%_off\" guy");
    assert_eq!(count(q).await, 1);

    // values: NULL, json, blob as hex, bit as binary digits
    let p = page(json!({ "schema": "otter_rows", "table": "customers", "limit": 10, "offset": 0,
                         "filters": [{ "column": "country", "op": "is null" }] })).await;
    let ada = &p["result"]["rows"][0];
    assert_eq!(ada[1], "Ada");
    assert!(ada[3].is_null());
    assert_eq!(ada[4], "{\"plan\": \"pro\"}");
    assert_eq!(ada[5], "\\xdead01");
    assert_eq!(ada[6], "101");

    let q = json!({ "schema": "otter_rows", "table": "orders", "limit": 100, "offset": 0, "whereRaw": "id <= 5000",
                    "filters": [{ "column": "note", "op": "is not null" }, { "column": "status", "op": "=", "value": "new" }] });
    let n = page(q.clone()).await["result"]["rows"].as_array().unwrap().len() as i64;
    assert!(n > 0);
    assert_eq!(count(q).await, n);
    assert_eq!(count(json!({ "schema": "otter_rows", "table": "orders", "limit": 1, "offset": 0 })).await, 100_000);

    // awkward names
    let p = page(json!({ "schema": "otter_rows", "table": "we`ird", "limit": 10, "offset": 0, "sort": { "column": "select", "desc": false } })).await;
    assert_eq!(p["result"]["columns"], json!(["Col A", "select"]));

    // a bad raw condition shows MySQL's error; extra statements are refused
    let err = call_err(&app, "table_rows", json!({ "id": id, "queryId": "q",
        "query": { "schema": "otter_rows", "table": "customers", "limit": 10, "offset": 0, "whereRaw": "nope = 1" } })).await;
    assert_eq!(err["code"], "1054", "{err}");
    for evil in ["1); DELETE FROM customers; SELECT (1", "1) /* ' */; DELETE FROM customers; SELECT * FROM customers WHERE (1 /* ' */"] {
        let err = call_err(&app, "table_rows", json!({ "id": id, "queryId": "q",
            "query": { "schema": "otter_rows", "table": "customers", "limit": 10, "offset": 0, "whereRaw": evil } })).await;
        assert!(err["message"].as_str().unwrap().contains("several statements"), "{err}");
    }
    assert_eq!(cell(&run(&app, &id, "SELECT count(*) FROM customers", None).await), "3");
    for ok in ["name <> 'a;b'", "name <> 'x;y' -- a; comment\n"] {
        let p = page(json!({ "schema": "otter_rows", "table": "customers", "limit": 10, "offset": 0, "whereRaw": ok })).await;
        assert_eq!(p["result"]["rows"].as_array().unwrap().len(), 3, "{ok}");
    }

    // a primary key renamed behind the app's back: paging recovers
    run(&app, &id, "CREATE TABLE pk_t (id INT PRIMARY KEY, v TEXT); INSERT INTO pk_t VALUES (1, 'a'), (2, 'b')", None).await;
    let first = json!({ "schema": "otter_rows", "table": "pk_t", "limit": 10, "offset": 0 });
    assert!(page(first.clone()).await["sql"].as_str().unwrap().contains("ORDER BY `id`"));
    run(&app, &id, "ALTER TABLE pk_t RENAME COLUMN id TO uid", None).await;
    let p = page(first).await;
    assert!(p["sql"].as_str().unwrap().contains("ORDER BY `uid`"), "{}", p["sql"]);
}

#[tokio::test]
async fn queries_limits_cancel() {
    let Some(port) = port() else { return };
    let app = app();
    let root = connected(&app, port, "").await;
    shop(&app, &root, "otter_q").await;
    let id = connected(&app, port, "otter_q").await;

    // several statements: one result each
    let out = run(&app, &id, "CREATE TEMPORARY TABLE t (x INT); INSERT INTO t VALUES (1), (2), (3); SELECT x, x * 2 AS y FROM t ORDER BY x; SELECT 'a' FROM t WHERE false", None).await;
    let r = out["results"].as_array().unwrap();
    assert_eq!(r.len(), 4);
    assert_eq!(r[0]["hasRows"], false);
    assert_eq!(r[1]["rowCount"], 3);
    assert_eq!(r[2]["rows"], json!([["1", "2"], ["2", "4"], ["3", "6"]]));
    assert_eq!(r[3]["hasRows"], true);
    assert_eq!(r[3]["rows"], json!([]));

    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "e", "sql": "SELECT nope FROM customers" })).await;
    assert_eq!(err["code"], "1054");
    assert!(err["message"].as_str().unwrap().contains("nope"));

    // row limit: rows kept, full count, the next statement still runs
    let out = run(&app, &id, "SELECT * FROM orders; SELECT 'after'", Some(1000)).await;
    assert_eq!(out["results"][0]["truncated"], true);
    assert_eq!(out["results"][0]["rows"].as_array().unwrap().len(), 1000);
    assert_eq!(out["results"][0]["rowCount"], 100_000);
    assert_eq!(out["results"][1]["rows"], json!([["after"]]));

    // byte cap
    let out = run(&app, &id, "SELECT REPEAT('x', 1024 * 1024) FROM orders LIMIT 200", Some(1000)).await;
    let kept = out["results"][0]["rows"].as_array().unwrap().len();
    assert!((50..=64).contains(&kept), "kept {kept}");
    assert_eq!(out["results"][0]["rowCount"], 200);

    // cancel
    let app = std::sync::Arc::new(app);
    let (a, i) = (app.clone(), id.clone());
    let slow = tokio::spawn(async move { a.dispatch("run_query", json!({ "id": i, "queryId": "slow", "sql": "SELECT SLEEP(30)" })).await });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = Instant::now();
    assert_eq!(call(&app, "cancel_query", json!({ "queryId": "slow" })).await, true);
    let err = serde_json::to_value(slow.await.unwrap().unwrap_err()).unwrap();
    assert_eq!(err["code"], "57014", "{err}");
    assert!(started.elapsed() < Duration::from_secs(3));
    // the pool still works afterwards
    for _ in 0..6 {
        assert_eq!(cell(&run(&app, &id, "SELECT 1", None).await), "1");
    }
}

#[tokio::test]
async fn query_tabs_keep_their_own_session() {
    let Some(port) = port() else { return };
    let app = app();
    let root = connected(&app, port, "").await;
    shop(&app, &root, "otter_tabs").await;
    let id = connected(&app, port, "otter_tabs").await;
    let conn_id = |out: Value| out["results"][0]["rows"][0][0].as_str().unwrap().to_string();

    let a = conn_id(run_in(&app, &id, "tab-a", "SELECT CONNECTION_ID()").await);
    assert_eq!(conn_id(run_in(&app, &id, "tab-a", "SELECT CONNECTION_ID()").await), a);
    assert_ne!(conn_id(run_in(&app, &id, "tab-b", "SELECT CONNECTION_ID()").await), a);

    // a transaction run one statement at a time stays in its tab
    run_in(&app, &id, "tab-a", "BEGIN").await;
    run_in(&app, &id, "tab-a", "DELETE FROM orders WHERE id <= 10").await;
    assert_eq!(cell(&run_in(&app, &id, "tab-a", "SELECT count(*) FROM orders WHERE id <= 10").await), "0");
    assert_eq!(cell(&run_in(&app, &id, "tab-b", "SELECT count(*) FROM orders WHERE id <= 10").await), "10");
    run_in(&app, &id, "tab-a", "ROLLBACK").await;
    assert_eq!(cell(&run_in(&app, &id, "tab-a", "SELECT count(*) FROM orders WHERE id <= 10").await), "10");

    // temporary tables live in the tab's session
    run_in(&app, &id, "tab-a", "CREATE TEMPORARY TABLE scratch (x INT)").await;
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "o", "sql": "SELECT * FROM scratch", "editor": "tab-b" })).await;
    assert_eq!(err["code"], "1146", "{err}");

    // closing the tab closes its connection
    call(&app, "editor_release", json!({ "editor": "tab-a" })).await;
    assert_ne!(conn_id(run_in(&app, &id, "tab-a", "SELECT CONNECTION_ID()").await), a);
}

#[tokio::test]
async fn read_only_connections() {
    let Some(port) = port() else { return };
    let app = app();
    let root = connected(&app, port, "").await;
    shop(&app, &root, "otter_ro").await;
    let mut ro = input(port, "root", "otter_ro", "prefer");
    ro["input"]["readOnly"] = json!(true);
    let id = call(&app, "connection_save", ro).await["id"].as_str().unwrap().to_string();
    assert_eq!(call(&app, "connect", json!({ "id": id })).await["readOnly"], true);

    assert_eq!(cell(&run(&app, &id, "SELECT count(*) FROM customers", None).await), "3");
    // pooled connections too: they are reset between uses, and stay read-only
    for _ in 0..6 {
        let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "w", "sql": "DELETE FROM customers" })).await;
        assert_eq!(err["code"], "1792", "{err}");
    }
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "w", "sql": "CREATE TABLE nope (a int)", "editor": "tab" })).await;
    assert_eq!(err["code"], "1792", "{err}");
    for sql in ["SET SESSION TRANSACTION READ WRITE", "START TRANSACTION READ WRITE", "SET SESSION transaction_read_only = 0"] {
        let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "w", "sql": sql, "editor": "tab" })).await;
        assert_eq!(err["code"], "read_only", "{sql}: {err}");
    }
}

/// The state of tab "t1"'s own session.
async fn tx(app: &App, id: &str) -> Value {
    call(app, "transaction_status", json!({ "id": id, "editor": "t1" })).await
}

#[tokio::test]
async fn transaction_status_of_a_tab() {
    let Some(port) = port() else { return };
    let app = app();
    let id = connected(&app, port, "").await;
    assert_eq!(tx(&app, &id).await, "none");
    run_in(&app, &id, "t1", "SELECT 1").await;
    assert_eq!(tx(&app, &id).await, "idle");
    run_in(&app, &id, "t1", "START TRANSACTION").await;
    assert_eq!(tx(&app, &id).await, "open");
    run_in(&app, &id, "t1", "COMMIT").await;
    assert_eq!(tx(&app, &id).await, "idle");
}

async fn export(app: &App, id: &str, source: Value, format: &str, path: &std::path::Path, extra: Value) -> Result<Value, Value> {
    let mut args = json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "source": source,
                           "format": format, "path": path });
    args.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    app.dispatch("export", args).await.map_err(|e| serde_json::to_value(e).unwrap())
}

#[tokio::test]
async fn export_tables_and_queries() {
    let Some(port) = port() else { return };
    let app = app();
    let id = connected(&app, port, "").await;
    shop(&app, &id, "export_shop").await;
    let dir = std::env::temp_dir().join(format!("dbotter-export-it-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();

    // a filtered table past the result limit
    let csv = dir.join("orders.csv");
    let table = json!({ "kind": "table", "query": { "schema": "export_shop", "table": "orders", "limit": 100, "offset": 0,
        "whereRaw": "status = 'paid'" } });
    let out = export(&app, &id, table, "csv", &csv, json!({})).await.unwrap();
    assert_eq!(out["rows"], 25000);
    assert!(std::fs::read_to_string(&csv).unwrap().starts_with("id,customer_id,amount,vat,status,note\n"));

    // SQL INSERTs load back: BLOB and BIT values included
    let sql = dir.join("customers.sql");
    let table = json!({ "kind": "table", "query": { "schema": "export_shop", "table": "customers", "limit": 100, "offset": 0 } });
    export(&app, &id, table, "sql", &sql, json!({ "target": "customers_copy" })).await.unwrap();
    run(&app, &id, "USE export_shop; CREATE TABLE customers_copy LIKE customers", None).await;
    run(&app, &id, &format!("USE export_shop; {}", std::fs::read_to_string(&sql).unwrap()), None).await;
    let diff = run(&app, &id, "SELECT count(*) FROM export_shop.customers c LEFT JOIN export_shop.customers_copy k \
        ON k.id = c.id AND k.name = c.name AND k.email <=> c.email AND k.country <=> c.country AND k.meta <=> c.meta \
        AND k.avatar <=> c.avatar AND k.flags <=> c.flags AND k.created_at = c.created_at WHERE k.id IS NULL", None).await;
    assert_eq!(cell(&diff), json!("0"));

    // a query: one statement that reads
    let path = dir.join("q.json");
    let source = json!({ "kind": "sql", "sql": "SELECT name, flags FROM export_shop.customers WHERE id = 1 # first" });
    export(&app, &id, source, "json", &path, json!({})).await.unwrap();
    let rows: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(rows, json!([{ "name": "Ada", "flags": "101" }]));
    let err = export(&app, &id, json!({ "kind": "sql", "sql": "SELECT * FROM export_shop.customers INTO OUTFILE '/tmp/x'" }),
        "csv", &dir.join("x.csv"), json!({})).await.unwrap_err();
    assert_eq!(err["code"], "not_read_only");
    run(&app, &id, "DROP DATABASE export_shop", None).await;
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn edits_save_all_or_nothing() {
    let Some(port) = port() else { return };
    let app = app();
    let id = connected(&app, port, "").await;
    run(&app, &id, "DROP DATABASE IF EXISTS edit_db; CREATE DATABASE edit_db;
        CREATE TABLE edit_db.t (id INT PRIMARY KEY, n INT, note TEXT); INSERT INTO edit_db.t VALUES (1, 1, 'a'), (2, 2, 'b')", None).await;
    let edits = |edits: Value| {
        let app = &app;
        let id = id.clone();
        async move {
            app.dispatch("apply_edits", json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "schema": "edit_db",
                "table": "t", "edits": edits })).await.map_err(|e| serde_json::to_value(e).unwrap())
        }
    };
    // the same value again: MySQL says 0 rows affected, but the row is there, so it saves
    let ok = edits(json!([{ "key": [["id", "1"]], "set": [["n", "1"]] }, { "key": [["id", "2"]], "set": [["note", null], ["n", "20"]] }])).await.unwrap();
    assert_eq!(ok["saved"], 2);
    let rows = run(&app, &id, "SELECT n, note FROM edit_db.t ORDER BY id", None).await;
    assert_eq!(rows["results"][0]["rows"], json!([["1", "a"], ["20", null]]));
    let err = edits(json!([{ "key": [["id", "1"]], "set": [["n", "5"]] }, { "key": [["id", "3"]], "set": [["n", "5"]] }])).await.unwrap_err();
    assert_eq!(err["code"], "stale_row");
    assert_eq!(cell(&run(&app, &id, "SELECT n FROM edit_db.t WHERE id = 1", None).await), json!("1"));
    run(&app, &id, "DROP DATABASE edit_db", None).await;
}
