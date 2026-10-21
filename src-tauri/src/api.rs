//! Every operation the UI can call, behind one `dispatch(command, args)` entry point.
//! The Tauri app exposes it as the `api` command; `examples/bridge.rs` exposes the same
//! function over HTTP so the UI can be tested in a normal browser.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::db::{Db, ExportFile, ExportSource};
use crate::error::{AppError, AppResult};
use crate::export::ExportFormat;
use crate::model::*;
use crate::secrets::Secrets;
use crate::store::Store;

pub const DEFAULT_MAX_ROWS: usize = 5_000;

pub struct App {
    pub db: Db,
    pub store: Store,
    pub secrets: Secrets,
    /// Passwords typed at connect time without saving, kept for this run only.
    session_passwords: Mutex<HashMap<String, String>>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn args<T: DeserializeOwned>(v: Value) -> AppResult<T> {
    serde_json::from_value(v).map_err(|e| AppError::new(format!("Bad arguments: {e}")))
}

fn ok<T: serde::Serialize>(v: T) -> AppResult<Value> {
    Ok(serde_json::to_value(v)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectArgs {
    id: String,
    password: Option<String>,
    /// Keep the typed password in the keychain.
    #[serde(default)]
    remember: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputArgs {
    input: ConnectionInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StructureArgs {
    id: String,
    schema: String,
    table: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TableArgs {
    id: String,
    query_id: String,
    query: TableQuery,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunArgs {
    id: String,
    query_id: String,
    sql: String,
    max_rows: Option<usize>,
    /// Query tab id: runs on that tab's own connection (transactions, SET… persist).
    editor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportArgs {
    id: String,
    query_id: String,
    source: ExportSource,
    format: ExportFormat,
    /// Absolute, or starting with `~/`.
    path: String,
    /// Replace an existing file; without it that is an error with code `exists`.
    #[serde(default)]
    overwrite: bool,
    target: Option<String>,
    /// Query tab id, to run on the tab's own connection.
    editor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorArgs {
    editor: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelArgs {
    query_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryArgs {
    limit: Option<usize>,
}

/// Opens the file manager with `path` selected.
async fn reveal(path: std::path::PathBuf) -> AppResult<()> {
    if !path.exists() {
        return Err(AppError::new(format!("{} isn't there any more", path.display())));
    }
    // talks to the file manager (D-Bus on Linux): keep it off the async threads
    tokio::task::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(&path))
        .await
        .map_err(|e| AppError::new(e.to_string()))?
        .map_err(|e| AppError::new(format!("Couldn't open the folder: {e}")))
}

impl App {
    pub fn new(store: Store, secrets: Secrets) -> Self {
        Self { db: Db::new(), store, secrets, session_passwords: Mutex::new(HashMap::new()) }
    }

    pub async fn dispatch(&self, cmd: &str, a: Value) -> AppResult<Value> {
        match cmd {
            "connections_list" => ok(self.store.connections()?),
            "connection_save" => ok(self.save_connection(args::<InputArgs>(a)?.input).await?),
            "connection_delete" => {
                let IdArgs { id } = args(a)?;
                self.db.disconnect(&id).await;
                // a missing keychain must not make the connection undeletable
                if let Err(e) = self.secrets.delete(&id).await {
                    eprintln!("keychain: {e}");
                }
                self.session_passwords.lock().await.remove(&id);
                self.store.delete_connection(&id)?;
                ok(())
            }
            "connection_test" => ok(self.test_connection(args::<InputArgs>(a)?.input).await?),
            "connect" => ok(self.connect(args(a)?).await?),
            "disconnect" => {
                let IdArgs { id } = args(a)?;
                self.db.disconnect(&id).await;
                ok(())
            }
            "session_info" => {
                let IdArgs { id } = args(a)?;
                ok(if self.db.is_connected(&id).await { Some(self.db.session_info(&id).await?) } else { None })
            }
            "schema" => {
                let IdArgs { id } = args(a)?;
                ok(self.db.schema(&id).await?)
            }
            "table_structure" => {
                let StructureArgs { id, schema, table } = args(a)?;
                ok(self.db.structure(&id, &schema, &table).await?)
            }
            "table_rows" => {
                let TableArgs { id, query_id, query } = args(a)?;
                ok(self.db.table_rows(&id, &query_id, &query).await?)
            }
            "table_count" => {
                let TableArgs { id, query_id, query } = args(a)?;
                ok(self.db.table_count(&id, &query_id, &query).await?)
            }
            "run_query" => ok(self.run_query(args(a)?).await?),
            "transaction_status" => {
                #[derive(Deserialize)]
                struct A {
                    id: String,
                    editor: String,
                }
                let A { id, editor } = args(a)?;
                ok(self.db.transaction_status(&id, &editor).await?)
            }
            "export" => {
                let a: ExportArgs = args(a)?;
                let file = ExportFile {
                    path: crate::export::resolve_path(&a.path)?,
                    format: a.format,
                    overwrite: a.overwrite,
                    target: a.target,
                };
                ok(self.db.export(&a.id, &a.query_id, &a.source, file, a.editor.as_deref()).await?)
            }
            "export_dir" => ok(crate::export::default_dir().display().to_string()),
            "reveal_path" => {
                #[derive(Deserialize)]
                struct A {
                    path: String,
                }
                let A { path } = args(a)?;
                ok(reveal(crate::export::resolve_path(&path)?).await?)
            }
            "editor_release" => {
                let EditorArgs { editor } = args(a)?;
                self.db.release_editor(&editor).await;
                ok(())
            }
            "cancel_query" => {
                let CancelArgs { query_id } = args(a)?;
                ok(self.db.cancel(&query_id).await?)
            }
            "history_list" => {
                let HistoryArgs { limit } = args(a)?;
                ok(self.store.history(limit.unwrap_or(200))?)
            }
            "history_clear" => ok(self.store.clear_history()?),
            other => Err(AppError::new(format!("Unknown command: {other}"))),
        }
    }

    async fn save_connection(&self, mut input: ConnectionInput) -> AppResult<ConnectionConfig> {
        let sqlite = input.kind == DbKind::Sqlite;
        if sqlite {
            // a SQLite file has no password
            input.password = None;
            input.save_password = false;
        }
        if sqlite && input.database.trim().is_empty() {
            return Err(AppError::new("The database file path is required"));
        }
        if !sqlite && (input.host.trim().is_empty() || input.user.trim().is_empty()) {
            return Err(AppError::new("Host and user are required"));
        }
        let existing = match &input.id {
            Some(id) => Some(self.store.connection(id)?),
            None => None,
        };
        let id = input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let file_name = || {
            let path = input.database.trim();
            std::path::Path::new(path).file_name().map_or(path.to_string(), |f| f.to_string_lossy().into_owned())
        };
        let conn = ConnectionConfig {
            id: id.clone(),
            kind: input.kind,
            name: match input.name.trim() {
                "" if sqlite => file_name(),
                "" => format!("{}@{}", input.database, input.host),
                name => name.to_string(),
            },
            host: input.host.trim().to_string(),
            port: input.port,
            database: input.database.trim().to_string(),
            user: input.user.trim().to_string(),
            ssl_mode: input.ssl_mode,
            save_password: input.save_password,
            color: input.color.filter(|c| !c.is_empty()),
            ssl_root_cert: input.ssl_root_cert.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()),
            read_only: input.read_only,
            production: input.production,
            created_at: existing.as_ref().map(|c| c.created_at).unwrap_or_else(now_ms),
        };

        // keychain first: if saving fails, the connection isn't saved half-way
        match (&input.password, input.save_password) {
            (Some(p), true) if !p.is_empty() => {
                self.secrets.set(&id, p).await?;
                // the new saved password wins over one typed earlier in this run
                self.session_passwords.lock().await.remove(&id);
            }
            // only an existing connection can have a saved password to remove; a missing
            // keychain isn't an error when nothing is to be stored
            (_, false) if existing.as_ref().is_some_and(|c| c.save_password) => {
                if let Err(e) = self.secrets.delete(&id).await {
                    eprintln!("keychain: {e}");
                }
            }
            _ => {}
        }
        if !input.save_password
            && let Some(p) = input.password.filter(|p| !p.is_empty())
        {
            self.session_passwords.lock().await.insert(id.clone(), p);
        }
        self.store.upsert_connection(conn.clone())?;
        // settings changed: the next query should use them
        if existing.is_some() {
            self.db.disconnect(&id).await;
        }
        Ok(conn)
    }

    async fn stored_password(&self, id: &str, save_password: bool) -> AppResult<Option<String>> {
        if let Some(p) = self.session_passwords.lock().await.get(id) {
            return Ok(Some(p.clone()));
        }
        if !save_password {
            return Ok(None);
        }
        // keychain unavailable or locked: ask for the password instead of failing
        Ok(self.secrets.get(id).await.unwrap_or_else(|e| {
            eprintln!("keychain: {e}");
            None
        }))
    }

    async fn test_connection(&self, input: ConnectionInput) -> AppResult<TestResult> {
        let password = match (&input.password, &input.id) {
            (Some(p), _) => Some(p.clone()),
            (None, Some(id)) => self.stored_password(id, input.save_password).await?,
            _ => None,
        };
        let conn = ConnectionConfig {
            kind: input.kind,
            id: input.id.clone().unwrap_or_default(),
            name: input.name,
            host: input.host,
            port: input.port,
            database: input.database,
            user: input.user,
            ssl_mode: input.ssl_mode,
            save_password: input.save_password,
            color: None,
            ssl_root_cert: input.ssl_root_cert,
            read_only: input.read_only,
            production: input.production,
            created_at: 0,
        };
        self.db.test(&conn, password.as_deref()).await
    }

    async fn connect(&self, a: ConnectArgs) -> AppResult<SessionInfo> {
        let conn = self.store.connection(&a.id)?;
        let password = match a.password.clone() {
            Some(p) => Some(p),
            None => self.stored_password(&a.id, conn.save_password).await?,
        };
        let info = self.db.connect(&conn, password.as_deref()).await?;
        // the typed password worked: remember it (keychain if asked, else for this run). A
        // keychain failure keeps it for this run rather than failing a working connection.
        if let Some(p) = a.password {
            let saved = a.remember && self.secrets.set(&a.id, &p).await.inspect_err(|e| eprintln!("keychain: {e}")).is_ok();
            if saved {
                self.session_passwords.lock().await.remove(&a.id);
                if !conn.save_password {
                    self.store.upsert_connection(ConnectionConfig { save_password: true, ..conn })?;
                }
            } else {
                self.session_passwords.lock().await.insert(a.id.clone(), p);
            }
        }
        Ok(info)
    }

    async fn run_query(&self, a: RunArgs) -> AppResult<Value> {
        let started = now_ms();
        let result = self
            .db
            .run(&a.id, &a.query_id, &a.sql, a.max_rows.unwrap_or(DEFAULT_MAX_ROWS), a.editor.as_deref(), false)
            .await;
        let entry = HistoryEntry {
            id: a.query_id.clone(),
            connection_id: a.id.clone(),
            sql: a.sql.clone(),
            ran_at: started,
            duration_ms: result.as_ref().map(|r| r.duration_ms).unwrap_or_else(|_| now_ms().saturating_sub(started)),
            row_count: result.as_ref().ok().and_then(|r| r.results.last().map(|s| s.row_count)),
            error: match &result {
                Err(e) => Some(e.message.clone()),
                Ok(out) if out.canceled => Some("cancelled after the row limit; later statements didn't run".into()),
                Ok(_) => None,
            },
        };
        // history is best-effort: a full disk shouldn't hide the query result
        if let Err(e) = self.store.add_history(&entry) {
            eprintln!("history: {e}");
        }
        Ok(json!(result?))
    }
}
