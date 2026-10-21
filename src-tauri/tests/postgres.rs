//! Integration tests against a real Postgres. Skipped unless DBOTTER_TEST_PORT is set.
//!
//! Expects the `shop` database from `scripts/seed-test-db.sql` and a role `otter` with
//! password `otter-pass` that must authenticate with a password:
//!
//!   DBOTTER_TEST_PORT=55432 cargo test --test postgres
//!
//! With TLS on the server (scripts/test-db.sh does that when openssl exists), set
//! DBOTTER_TEST_CA to its CA certificate to also test the TLS modes.

use std::time::{Duration, Instant};

use dbotter_lib::api::App;
use dbotter_lib::secrets::Secrets;
use dbotter_lib::store::Store;
use serde_json::{Value, json};

fn port() -> Option<u16> {
    std::env::var("DBOTTER_TEST_PORT").ok().and_then(|p| p.parse().ok())
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

/// Saves a connection as `user` (no password) and returns its id.
async fn saved(app: &App, port: u16, user: &str) -> String {
    let conn = call(
        app,
        "connection_save",
        json!({ "input": { "name": "", "host": "127.0.0.1", "port": port, "database": "shop",
                           "user": user, "sslMode": "prefer", "savePassword": false } }),
    )
    .await;
    conn["id"].as_str().unwrap().to_string()
}

async fn run(app: &App, id: &str, sql: &str, max_rows: Option<usize>) -> Value {
    call(app, "run_query", json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "sql": sql, "maxRows": max_rows }))
        .await
}

/// Runs on a query tab's own connection.
async fn run_in(app: &App, id: &str, editor: &str, sql: &str) -> Value {
    call(app, "run_query", json!({ "id": id, "queryId": uuid::Uuid::new_v4().to_string(), "sql": sql, "editor": editor })).await
}

fn cell(out: &Value) -> Value {
    out["results"].as_array().unwrap().last().unwrap()["rows"][0][0].clone()
}

#[tokio::test]
async fn password_flow_and_keychain() {
    let Some(port) = port() else { return };
    let app = app();
    let id = saved(&app, port, "otter").await;

    let err = call_err(&app, "connect", json!({ "id": id })).await;
    assert_eq!(err["code"], "password_required", "{err}");

    let err = call_err(&app, "connect", json!({ "id": id, "password": "nope" })).await;
    assert_eq!(err["code"], "password_required");
    assert!(err["message"].as_str().unwrap().contains("password authentication failed"), "{err}");

    let info = call(&app, "connect", json!({ "id": id, "password": "otter-pass" })).await;
    assert_eq!(info["user"], "otter");
    assert!(info["serverVersion"].as_str().unwrap().starts_with(|c: char| c.is_ascii_digit()));

    // reconnect in the same run reuses the typed password
    call(&app, "disconnect", json!({ "id": id })).await;
    call(&app, "connect", json!({ "id": id })).await;

    // a test with the form's values (no password typed) uses the remembered one
    let test = call(
        &app,
        "connection_test",
        json!({ "input": { "id": id, "name": "x", "host": "127.0.0.1", "port": port, "database": "shop",
                           "user": "otter", "sslMode": "disable", "savePassword": false } }),
    )
    .await;
    assert!(test["latencyMs"].is_u64());

    // keychain: a fresh app (new run) finds the saved password
    let keychain = Secrets::new("DbOtter (tests)");
    match keychain.set("probe", "x").await {
        Err(e) => eprintln!("skipping keychain checks: {e}"),
        Ok(()) => {
            keychain.delete("probe").await.unwrap();
            call(&app, "disconnect", json!({ "id": id })).await;
            call(&app, "connect", json!({ "id": id, "password": "otter-pass", "remember": true })).await;
            let conns = call(&app, "connections_list", json!(null)).await;
            assert_eq!(conns[0]["savePassword"], true);
            let stored = keychain.get(&id).await.unwrap();
            assert_eq!(stored.as_deref(), Some("otter-pass"));
            call(&app, "connection_delete", json!({ "id": id })).await;
            assert_eq!(keychain.get(&id).await.unwrap(), None, "delete removes the keychain entry");
        }
    }
}

#[tokio::test]
async fn schema_and_structure() {
    let Some(port) = port() else { return };
    let app = app();
    let id = saved(&app, port, "postgres").await;
    call(&app, "connect", json!({ "id": id })).await;

    let tree = call(&app, "schema", json!({ "id": id })).await;
    let schemas: Vec<&str> = tree["schemas"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(schemas[0], "public", "public first");
    assert!(schemas.contains(&"sales"));
    assert!(!schemas.iter().any(|s| s.starts_with("pg_") || *s == "information_schema"));

    let sales = tree["schemas"].as_array().unwrap().iter().find(|s| s["name"] == "sales").unwrap();
    let kinds: Vec<(String, String)> = sales["relations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["name"].as_str().unwrap().to_string(), r["kind"].as_str().unwrap().to_string()))
        .collect();
    assert!(kinds.contains(&("orders".into(), "table".into())));
    assert!(kinds.contains(&("big_orders".into(), "view".into())));
    assert!(kinds.contains(&("revenue_by_status".into(), "materializedView".into())));
    let orders = sales["relations"].as_array().unwrap().iter().find(|r| r["name"] == "orders").unwrap();
    assert!(orders["estimatedRows"].as_i64().unwrap() > 900_000);
    assert_eq!(orders["columns"][2]["name"], "amount");
    assert_eq!(orders["columns"][2]["dataType"], "numeric(10,2)");

    let s = call(&app, "table_structure", json!({ "id": id, "schema": "public", "table": "customers" })).await;
    assert_eq!(s["comment"], "People who bought something");
    let cols = s["columns"].as_array().unwrap();
    assert_eq!(cols[0]["name"], "id");
    assert_eq!(cols[0]["primaryKey"], true);
    assert_eq!(cols[1]["nullable"], false);
    let vip = cols.iter().find(|c| c["name"] == "vip").unwrap();
    assert_eq!(vip["default"], "false");
    assert_eq!(vip["comment"], "Gets free shipping");
    assert!(s["indexes"].as_array().unwrap().iter().any(|i| i["primary"] == true));
    assert!(s["totalSize"].as_str().unwrap().ends_with("kB") || s["totalSize"].as_str().unwrap().ends_with("MB"));

    let o = call(&app, "table_structure", json!({ "id": id, "schema": "sales", "table": "orders" })).await;
    let kinds: Vec<&str> = o["constraints"].as_array().unwrap().iter().map(|c| c["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds[0], "primary key");
    assert!(kinds.contains(&"foreign key") && kinds.contains(&"check"));
    // Postgres 18 lists NOT NULL as constraints too; those belong to the columns view
    assert!(!kinds.contains(&"other"), "{kinds:?}");
    let partial = o["indexes"].as_array().unwrap().iter().find(|i| i["name"] == "orders_status_idx").unwrap();
    assert!(partial["definition"].as_str().unwrap().contains("WHERE"));

    let v = call(&app, "table_structure", json!({ "id": id, "schema": "sales", "table": "big_orders" })).await;
    assert!(v["definition"].as_str().unwrap().contains("amount > "));
    assert!(v["totalSize"].is_null());

    let err = call_err(&app, "table_structure", json!({ "id": id, "schema": "public", "table": "nope" })).await;
    assert_eq!(err["code"], "not_found");
}

#[tokio::test]
async fn table_rows_filters_and_sort() {
    let Some(port) = port() else { return };
    let app = app();
    let id = saved(&app, port, "postgres").await;
    call(&app, "connect", json!({ "id": id })).await;
    let page = |query: Value| {
        let app = &app;
        let id = id.clone();
        async move { call(app, "table_rows", json!({ "id": id, "queryId": "q", "query": query })).await }
    };

    let p = page(json!({ "schema": "sales", "table": "orders", "limit": 100, "offset": 0 })).await;
    assert_eq!(p["result"]["rows"].as_array().unwrap().len(), 100);
    assert_eq!(p["result"]["truncated"], false);
    assert_eq!(p["result"]["columns"][0], "id");

    let p = page(json!({ "schema": "sales", "table": "orders", "limit": 5, "offset": 10,
                         "sort": { "column": "amount", "desc": true } }))
    .await;
    let amounts: Vec<f64> =
        p["result"]["rows"].as_array().unwrap().iter().map(|r| r[2].as_str().unwrap().parse().unwrap()).collect();
    assert!(amounts.windows(2).all(|w| w[0] >= w[1]));
    assert!(p["sql"].as_str().unwrap().ends_with("ORDER BY \"amount\" DESC LIMIT 5 OFFSET 10"));

    // LIKE wildcards and quotes in the value match literally
    let p = page(json!({ "schema": "public", "table": "customers", "limit": 50, "offset": 0,
                         "filters": [{ "column": "name", "op": "contains", "value": "\"the 50%_off\"" }] }))
    .await;
    let rows = p["result"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0][1], "O'Brien \"the 50%_off\" guy");

    let filters = json!([{ "column": "country", "op": "is null" }, { "column": "vip", "op": "=", "value": "true" }]);
    let q = json!({ "schema": "public", "table": "customers", "limit": 1000, "offset": 0, "filters": filters,
                    "whereRaw": "id < 2000" });
    let p = page(q.clone()).await;
    let n = p["result"]["rows"].as_array().unwrap().len() as i64;
    let count = call(&app, "table_count", json!({ "id": id, "queryId": "c", "query": q })).await;
    assert_eq!(count.as_i64().unwrap(), n);
    assert!(n > 0);

    // NULLs come back as null, json/arrays/bytea as Postgres text
    let p = page(json!({ "schema": "public", "table": "customers", "limit": 3, "offset": 0,
                         "sort": { "column": "id", "desc": false } }))
    .await;
    let row = &p["result"]["rows"][2]; // id 3: meta set, country Brazil
    assert_eq!(row[3], "Brazil");
    assert!(row[5].as_str().unwrap().contains("\"plan\": \"pro\""));
    assert_eq!(row[6], "{tag3}");
    let row = &p["result"]["rows"][0];
    assert!(row[5].is_null());

    // identifiers needing quotes
    let p = page(json!({ "schema": "public", "table": "Weird \"Name\" Table", "limit": 10, "offset": 0,
                         "sort": { "column": "select", "desc": false } }))
    .await;
    assert_eq!(p["result"]["columns"], json!(["Col A", "select"]));
    assert_eq!(p["result"]["rows"][0][1], "reserved word column");

    let err = call_err(&app, "table_rows", json!({ "id": id, "queryId": "q",
        "query": { "schema": "public", "table": "customers", "limit": 10, "offset": 0, "whereRaw": "nope = 1" } }))
    .await;
    assert_eq!(err["code"], "42703");

    // the raw WHERE can't add statements, whatever the quoting tricks
    let raw = |w: &str| json!({ "id": id, "queryId": "q",
        "query": { "schema": "public", "table": "customers", "limit": 10, "offset": 0, "whereRaw": w } });
    for evil in ["true); DELETE FROM customers; SELECT (1", "true) /* ' */; DELETE FROM customers; SELECT * FROM customers WHERE (true /* ' */"] {
        let err = call_err(&app, "table_rows", raw(evil)).await;
        assert!(err["message"].as_str().unwrap().contains("several statements"), "{err}");
        let err = call_err(&app, "table_count", raw(evil)).await;
        assert!(err["message"].as_str().unwrap().contains("several statements"), "{err}");
    }
    assert_eq!(cell(&run(&app, &id, "SELECT count(*) FROM customers", None).await), "2501");
    // semicolons inside literals are fine
    for ok in ["name <> $$a;b$$", "name <> E'it\\'s;'", "name <> 'x;y' -- a; comment"] {
        let page = call(&app, "table_rows", raw(ok)).await;
        assert_eq!(page["result"]["rows"].as_array().unwrap().len(), 10, "{ok}");
    }
}

#[tokio::test]
async fn queries_errors_limits_cancel_history() {
    let Some(port) = port() else { return };
    let app = app();
    let id = saved(&app, port, "postgres").await;
    call(&app, "connect", json!({ "id": id })).await;

    // several statements: one result per statement
    let out = run(&app, &id, "CREATE TEMP TABLE t(x int); INSERT INTO t VALUES (1),(2),(3); SELECT x, x * 2 AS y FROM t ORDER BY x; SELECT 'a' WHERE false", None).await;
    let results = out["results"].as_array().unwrap();
    assert_eq!(results.len(), 4);
    assert_eq!(results[0]["hasRows"], false);
    assert_eq!(results[1]["rowCount"], 3);
    assert_eq!(results[2]["columns"], json!(["x", "y"]));
    assert_eq!(results[2]["rows"], json!([["1", "2"], ["2", "4"], ["3", "6"]]));
    assert_eq!(results[3]["hasRows"], true);
    assert_eq!(results[3]["rows"], json!([]));

    // errors carry SQLSTATE and the position of the bad token
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "e", "sql": "SELECT id, nam FROM customers" })).await;
    assert_eq!(err["code"], "42703");
    assert_eq!(err["position"], 12);
    assert!(err["hint"].as_str().unwrap_or("").contains("name"), "{err}");

    // row limit on a 1M-row table: keeps 1,000 rows, reports the full count, and the
    // statement after it still runs
    let started = Instant::now();
    let out = run(&app, &id, "SELECT * FROM sales.orders; SELECT 'after'", Some(1000)).await;
    let r = &out["results"][0];
    assert_eq!(r["truncated"], true);
    assert_eq!(r["rows"].as_array().unwrap().len(), 1000);
    assert_eq!(r["rowCount"], 1_000_000);
    assert_eq!(out["results"][1]["rows"], json!([["after"]]));
    assert!(started.elapsed() < Duration::from_secs(15), "took {:?}", started.elapsed());

    // the byte cap stops huge values before the row limit
    let out = run(&app, &id, "SELECT repeat('x', 1024 * 1024) FROM generate_series(1, 200)", Some(1000)).await;
    let r = &out["results"][0];
    assert_eq!(r["truncated"], true);
    let kept = r["rows"].as_array().unwrap().len();
    assert!((50..=64).contains(&kept), "kept {kept}");
    assert_eq!(r["rowCount"], 200);
    for _ in 0..6 {
        let out = run(&app, &id, "SELECT 1", None).await;
        assert_eq!(out["results"][0]["rows"], json!([["1"]]));
    }

    // cancel a running query from another task
    let app = std::sync::Arc::new(app);
    let (a, i) = (app.clone(), id.clone());
    let running = tokio::spawn(async move {
        a.dispatch("run_query", json!({ "id": i, "queryId": "slow", "sql": "SELECT pg_sleep(30)" })).await
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    let started = Instant::now();
    assert_eq!(call(&app, "cancel_query", json!({ "queryId": "slow" })).await, true);
    let err = serde_json::to_value(running.await.unwrap().unwrap_err()).unwrap();
    assert_eq!(err["code"], "57014", "{err}");
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(call(&app, "cancel_query", json!({ "queryId": "slow" })).await, false);

    let history = call(&app, "history_list", json!({ "limit": 50 })).await;
    let h = history.as_array().unwrap();
    assert_eq!(h[0]["sql"], "SELECT pg_sleep(30)");
    assert!(h[0]["error"].as_str().unwrap().contains("cancel"));
    assert!(h.iter().any(|e| e["sql"] == "SELECT id, nam FROM customers" && e["error"].is_string()));
    call(&app, "history_clear", json!(null)).await;
    assert_eq!(call(&app, "history_list", json!({})).await, json!([]));

    let err = call_err(&app, "run_query", json!({ "id": "missing", "queryId": "x", "sql": "select 1" })).await;
    assert_eq!(err["code"], "not_connected");
}

#[tokio::test]
async fn connection_errors_are_readable() {
    let Some(port) = port() else { return };
    let app = app();
    let input = |p: u16, db: &str| {
        json!({ "input": { "name": "x", "host": "127.0.0.1", "port": p, "database": db, "user": "postgres",
                           "sslMode": "disable", "savePassword": false } })
    };
    let err = call_err(&app, "connection_test", input(1, "shop")).await;
    assert!(err["message"].as_str().unwrap().to_lowercase().contains("refused"), "{err}");
    let err = call_err(&app, "connection_test", input(port, "nope")).await;
    assert_eq!(err["code"], "3D000", "{err}");
    // an unknown role is not a password problem
    let mut ghost = input(port, "shop");
    ghost["input"]["user"] = json!("ghost");
    let err = call_err(&app, "connection_test", ghost).await;
    assert_eq!(err["code"], "28000", "{err}");
    assert!(err["message"].as_str().unwrap().contains("ghost"));
    let ok = call(&app, "connection_test", input(port, "shop")).await;
    assert!(ok["serverVersion"].is_string());

    // require against a server without TLS fails clearly (the TLS cases are in tls_modes)
    if std::env::var("DBOTTER_TEST_CA").is_err() {
        let mut tls = input(port, "shop");
        tls["input"]["sslMode"] = json!("require");
        let err = call_err(&app, "connection_test", tls).await;
        let msg = err["message"].as_str().unwrap();
        assert!(msg.to_lowercase().contains("tls") || msg.contains("SSL"), "{err}");
    }
}

/// Connects the saved connection and reports whether the session uses TLS ("t" / "f").
async fn ssl_used(app: &App, conn: Value) -> Value {
    let id = conn["id"].as_str().unwrap().to_string();
    call(app, "connect", json!({ "id": id })).await;
    cell(&run(app, &id, "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()", None).await)
}

#[tokio::test]
async fn tls_modes() {
    let (Some(port), Ok(ca)) = (port(), std::env::var("DBOTTER_TEST_CA")) else { return };
    let app = app();
    let save = |mode: &str, host: &str, ca: Option<&str>| {
        json!({ "input": { "name": mode, "host": host, "port": port, "database": "shop", "user": "postgres",
                           "sslMode": mode, "savePassword": false, "sslRootCert": ca } })
    };
    for (mode, want) in [("disable", "f"), ("prefer", "t"), ("require", "t")] {
        let conn = call(&app, "connection_save", save(mode, "127.0.0.1", None)).await;
        assert_eq!(ssl_used(&app, conn).await, want, "{mode}");
    }
    // the test CA isn't a system root: verify-full must refuse, then accept with the CA file
    let err = call_err(&app, "connection_test", save("verify-full", "127.0.0.1", None)).await;
    assert!(err["message"].as_str().unwrap().to_lowercase().contains("certificate"), "{err}");
    for host in ["127.0.0.1", "localhost"] {
        let conn = call(&app, "connection_save", save("verify-full", host, Some(&ca))).await;
        assert_eq!(ssl_used(&app, conn).await, "t", "{host}");
    }
    let err = call_err(&app, "connection_test", save("verify-full", "127.0.0.1", Some("/nonexistent.pem"))).await;
    assert!(err["message"].as_str().unwrap().contains("Can't read CA certificate"), "{err}");
}

#[tokio::test]
async fn query_tabs_keep_their_own_session() {
    let Some(port) = port() else { return };
    let app = app();
    let id = saved(&app, port, "postgres").await;
    call(&app, "connect", json!({ "id": id })).await;
    let pid = |out: Value| out["results"][0]["rows"][0][0].as_str().unwrap().to_string();

    let a = pid(run_in(&app, &id, "tab-a", "SELECT pg_backend_pid()").await);
    assert_eq!(pid(run_in(&app, &id, "tab-a", "SELECT pg_backend_pid()").await), a);
    let b = pid(run_in(&app, &id, "tab-b", "SELECT pg_backend_pid()").await);
    assert_ne!(a, b);

    // a transaction run one statement at a time stays on the tab's connection
    run_in(&app, &id, "tab-a", "BEGIN").await;
    run_in(&app, &id, "tab-a", "CREATE TEMP TABLE scratch(x int)").await;
    run_in(&app, &id, "tab-a", "INSERT INTO scratch VALUES (1), (2)").await;
    assert_eq!(cell(&run_in(&app, &id, "tab-a", "SELECT count(*) FROM scratch").await), "2");
    // other tabs and browsing don't see it
    let other = call_err(&app, "run_query", json!({ "id": id, "queryId": "o", "sql": "SELECT * FROM scratch", "editor": "tab-b" })).await;
    assert_eq!(other["code"], "42P01");
    run_in(&app, &id, "tab-a", "ROLLBACK").await;
    assert!(cell(&run_in(&app, &id, "tab-a", "SELECT to_regclass('pg_temp.scratch')").await).is_null());

    // an aborted transaction stays with the tab instead of poisoning browsing
    run_in(&app, &id, "tab-a", "BEGIN").await;
    call_err(&app, "run_query", json!({ "id": id, "queryId": "z", "sql": "SELECT 1/0", "editor": "tab-a" })).await;
    for _ in 0..6 {
        let page = call(&app, "table_rows", json!({ "id": id, "queryId": "p",
            "query": { "schema": "public", "table": "customers", "limit": 5, "offset": 0 } })).await;
        assert_eq!(page["result"]["rows"].as_array().unwrap().len(), 5);
    }
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "y", "sql": "SELECT 1", "editor": "tab-a" })).await;
    assert_eq!(err["code"], "25P02");
    run_in(&app, &id, "tab-a", "ROLLBACK").await;

    // a truncated result inside a transaction leaves it usable
    run_in(&app, &id, "tab-a", "BEGIN").await;
    let out = call(&app, "run_query", json!({ "id": id, "queryId": "t", "sql": "SELECT * FROM sales.orders", "maxRows": 10, "editor": "tab-a" })).await;
    assert_eq!(out["results"][0]["truncated"], true);
    assert_eq!(cell(&run_in(&app, &id, "tab-a", "SELECT 1").await), "1");
    run_in(&app, &id, "tab-a", "COMMIT").await;

    // cancelling while rows past the limit are being skipped: the kept rows come back,
    // flagged, and the tab's transaction is aborted as Postgres says
    run_in(&app, &id, "tab-a", "BEGIN").await;
    let app = std::sync::Arc::new(app);
    let (a2, i2) = (app.clone(), id.clone());
    let big = tokio::spawn(async move {
        a2.dispatch("run_query", json!({ "id": i2, "queryId": "big", "maxRows": 10, "editor": "tab-a",
            "sql": "SELECT * FROM sales.orders CROSS JOIN generate_series(1, 20)" })).await
    });
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert_eq!(call(&app, "cancel_query", json!({ "queryId": "big" })).await, true);
    let out = big.await.unwrap().unwrap();
    assert_eq!(out["canceled"], true);
    assert_eq!(out["results"][0]["rows"].as_array().unwrap().len(), 10);
    let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "after", "sql": "SELECT 1", "editor": "tab-a" })).await;
    assert_eq!(err["code"], "25P02");
    run_in(&app, &id, "tab-a", "ROLLBACK").await;

    // ...but a batch that wrote something first reports the cancel: the whole batch was one
    // implicit transaction, so the write was rolled back and must not look done
    run_in(&app, &id, "tab-a", "CREATE TEMP TABLE w(x int)").await;
    let (a3, i3) = (app.clone(), id.clone());
    let batch = tokio::spawn(async move {
        a3.dispatch("run_query", json!({ "id": i3, "queryId": "batch", "maxRows": 10, "editor": "tab-a",
            "sql": "INSERT INTO w VALUES (1); SELECT * FROM sales.orders CROSS JOIN generate_series(1, 20)" })).await
    });
    tokio::time::sleep(Duration::from_millis(800)).await;
    call(&app, "cancel_query", json!({ "queryId": "batch" })).await;
    let err = serde_json::to_value(batch.await.unwrap().unwrap_err()).unwrap();
    assert_eq!(err["code"], "57014", "{err}");
    assert_eq!(cell(&run_in(&app, &id, "tab-a", "SELECT count(*) FROM w").await), "0");

    // the WHERE check waits on locks like any query, and can be cancelled while it waits
    run_in(&app, &id, "tab-b", "BEGIN").await;
    run_in(&app, &id, "tab-b", "LOCK TABLE public.customers IN ACCESS EXCLUSIVE MODE").await;
    let (a4, i4) = (app.clone(), id.clone());
    let browse = tokio::spawn(async move {
        a4.dispatch("table_rows", json!({ "id": i4, "queryId": "locked",
            "query": { "schema": "public", "table": "customers", "limit": 5, "offset": 0, "whereRaw": "id > 1" } })).await
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(call(&app, "cancel_query", json!({ "queryId": "locked" })).await, true);
    let started = Instant::now();
    let err = serde_json::to_value(browse.await.unwrap().unwrap_err()).unwrap();
    assert_eq!(err["code"], "57014", "{err}");
    assert!(started.elapsed() < Duration::from_secs(3));
    run_in(&app, &id, "tab-b", "ROLLBACK").await;

    // closing the tab closes its connection
    call(&app, "editor_release", json!({ "editor": "tab-a" })).await;
    assert_ne!(pid(run_in(&app, &id, "tab-a", "SELECT pg_backend_pid()").await), a);
}

#[tokio::test]
async fn structure_details_and_stable_paging() {
    let Some(port) = port() else { return };
    let app = app();
    let id = saved(&app, port, "postgres").await;
    call(&app, "connect", json!({ "id": id })).await;

    let s = call(&app, "table_structure", json!({ "id": id, "schema": "sales", "table": "invoices" })).await;
    let cols = s["columns"].as_array().unwrap();
    assert_eq!(cols[0]["generated"], "GENERATED ALWAYS AS IDENTITY");
    assert_eq!(cols[2]["generated"], "GENERATED ALWAYS AS ((net * 0.2)) STORED");
    assert!(cols[2]["default"].is_null());

    let p = call(&app, "table_structure", json!({ "id": id, "schema": "sales", "table": "events" })).await;
    assert_ne!(p["totalSize"], "0 bytes", "partitioned size sums its partitions");
    let tree = call(&app, "schema", json!({ "id": id })).await;
    let sales = tree["schemas"].as_array().unwrap().iter().find(|s| s["name"] == "sales").unwrap();
    let names: Vec<&str> = sales["relations"].as_array().unwrap().iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"events") && !names.contains(&"events_2025"));

    // no sort chosen: pages follow the primary key
    let page = call(&app, "table_rows", json!({ "id": id, "queryId": "q",
        "query": { "schema": "sales", "table": "orders", "limit": 3, "offset": 3 } })).await;
    assert!(page["sql"].as_str().unwrap().contains("ORDER BY \"id\""));
    assert_eq!(page["result"]["rows"][0][0], "4");

    // a primary key renamed behind the app's back: paging recovers instead of failing
    run(&app, &id, "DROP TABLE IF EXISTS public.pk_t; CREATE TABLE public.pk_t(id int PRIMARY KEY, v text); INSERT INTO public.pk_t SELECT g, 'v' FROM generate_series(1, 5) g", None).await;
    let pk_page = json!({ "id": id, "queryId": "pk", "query": { "schema": "public", "table": "pk_t", "limit": 3, "offset": 0 } });
    let page = call(&app, "table_rows", pk_page.clone()).await;
    assert!(page["sql"].as_str().unwrap().contains("ORDER BY \"id\""));
    run(&app, &id, "ALTER TABLE public.pk_t RENAME COLUMN id TO uid", None).await;
    let page = call(&app, "table_rows", pk_page).await;
    assert!(page["sql"].as_str().unwrap().contains("ORDER BY \"uid\""), "{}", page["sql"]);
    run(&app, &id, "DROP TABLE public.pk_t", None).await;

    // json has no = operator: compare as text (seats = 3 for ids 3, 33, 63, … 2493)
    let q = json!({ "schema": "public", "table": "customers", "limit": 10, "offset": 0,
                    "filters": [{ "column": "meta", "op": "=", "value": "{\"plan\": \"pro\", \"seats\": 3}", "asText": true }] });
    let page = call(&app, "table_rows", json!({ "id": id, "queryId": "q", "query": q })).await;
    assert_eq!(page["result"]["rows"][1][0], "33");
    assert_eq!(call(&app, "table_count", json!({ "id": id, "queryId": "c", "query": q })).await, 84);
}

#[tokio::test]
async fn read_only_connections() {
    let Some(port) = port() else { return };
    let app = app();
    let conn = call(&app, "connection_save", json!({ "input": { "name": "ro", "host": "127.0.0.1", "port": port, "database": "shop",
        "user": "postgres", "sslMode": "disable", "savePassword": false, "readOnly": true } })).await;
    let id = conn["id"].as_str().unwrap().to_string();
    assert_eq!(call(&app, "connect", json!({ "id": id })).await["readOnly"], true);

    // reads and browsing work
    assert_eq!(cell(&run(&app, &id, "SELECT count(*) FROM customers", None).await), "2501");
    let page = call(&app, "table_rows", json!({ "id": id, "queryId": "p", "query": { "schema": "public", "table": "customers", "limit": 5, "offset": 0 } })).await;
    assert_eq!(page["result"]["rows"].as_array().unwrap().len(), 5);

    // the server refuses writes and DDL, in query tabs too
    for sql in ["UPDATE customers SET name = 'x' WHERE id = 1", "CREATE TABLE nope (a int)", "DELETE FROM customers"] {
        let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "w", "sql": sql, "editor": "tab" })).await;
        assert_eq!(err["code"], "25006", "{sql}: {err}");
    }
    // and the app refuses switching it back on
    for sql in ["SET default_transaction_read_only = off", "BEGIN READ WRITE", "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE"] {
        let err = call_err(&app, "run_query", json!({ "id": id, "queryId": "w", "sql": sql, "editor": "tab" })).await;
        assert_eq!(err["code"], "read_only", "{sql}: {err}");
    }
    assert_eq!(cell(&run(&app, &id, "SELECT name FROM customers WHERE id = 1", None).await), "Customer 1");
}
