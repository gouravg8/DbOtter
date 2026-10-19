//! Development bridge: serves `App::dispatch` over HTTP so the UI can run in a normal
//! browser (`pnpm dev:browser`) and be tested end to end with Playwright.
//!
//!   cargo run --example bridge -- <port> <data-dir>
//!
//! POST /api {"cmd": "...", "args": {...}} -> 200 with the result, or 400 with the error.
//! Listens on 127.0.0.1 only and answers only the dev UI's origin (DBOTTER_BRIDGE_ORIGINS,
//! comma-separated; default the Vite dev server), so other websites open in the same
//! browser can't drive it. Not part of the app build.

use std::sync::Arc;

use dbotter_lib::api::App;
use dbotter_lib::secrets::Secrets;
use dbotter_lib::store::Store;
use serde_json::Value;

fn main() {
    let mut argv = std::env::args().skip(1);
    let (Some(port), Some(dir)) = (argv.next().and_then(|p| p.parse::<u16>().ok()), argv.next()) else {
        eprintln!("usage: bridge <port> <data-dir>");
        std::process::exit(2);
    };
    let origins: Vec<String> = std::env::var("DBOTTER_BRIDGE_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:1420,http://127.0.0.1:1420".into())
        .split(',')
        .map(|o| o.trim().to_string())
        .collect();
    let origins = Arc::new(origins);
    // a separate keychain service so tests never touch the app's saved passwords
    let service = std::env::var("DBOTTER_KEYCHAIN_SERVICE").unwrap_or_else(|_| "DbOtter (dev bridge)".into());

    let app = Arc::new(App::new(Store::new(dir.into()).expect("data dir"), Secrets::new(service)));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let server = tiny_http::Server::http(("127.0.0.1", port)).expect("bind");
    println!("bridge listening on http://127.0.0.1:{port}");

    for mut req in server.incoming_requests() {
        let app = app.clone();
        let origins = origins.clone();
        let handle = runtime.handle().clone();
        // one thread per request so a long query doesn't block a cancel
        std::thread::spawn(move || {
            // browsers always send Origin on cross-origin requests; scripts (tests) may not
            let origin = req.headers().iter().find(|h| h.field.equiv("Origin")).map(|h| h.value.to_string());
            if origin.as_ref().is_some_and(|o| !origins.contains(o)) {
                let _ = req.respond(tiny_http::Response::from_string("origin not allowed").with_status_code(403));
                return;
            }
            let allow = origin.unwrap_or_else(|| origins[0].clone());
            let cors = [
                tiny_http::Header::from_bytes("Access-Control-Allow-Origin", allow.as_bytes()).unwrap(),
                tiny_http::Header::from_bytes("Vary", "Origin").unwrap(),
                tiny_http::Header::from_bytes("Access-Control-Allow-Headers", "content-type").unwrap(),
                tiny_http::Header::from_bytes("Content-Type", "application/json").unwrap(),
            ];
            let respond = |req: tiny_http::Request, status: u16, body: String| {
                let mut res = tiny_http::Response::from_string(body).with_status_code(status);
                for h in &cors {
                    res.add_header(h.clone());
                }
                let _ = req.respond(res);
            };
            if req.method() == &tiny_http::Method::Options {
                return respond(req, 204, String::new());
            }
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let cmd = parsed["cmd"].as_str().unwrap_or("").to_string();
            let args = parsed.get("args").cloned().unwrap_or(Value::Null);
            match handle.block_on(app.dispatch(&cmd, args)) {
                Ok(v) => respond(req, 200, v.to_string()),
                Err(e) => respond(req, 400, serde_json::to_string(&e).unwrap()),
            }
        });
    }
}
