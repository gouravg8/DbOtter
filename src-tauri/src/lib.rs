pub mod api;
pub mod db;
pub mod error;
pub mod export;
pub mod model;
pub mod mysql;
pub mod pg;
pub mod results;
pub mod running;
pub mod secrets;
pub mod sql;
pub mod sqlite;
pub mod store;

use serde_json::Value;
use tauri::Manager;

use crate::api::App;
use crate::error::AppError;

/// Keychain service name passwords are stored under.
pub const KEYCHAIN_SERVICE: &str = "DbOtter";

/// The single entry point for the UI; see `api::App::dispatch` for the commands.
#[tauri::command]
async fn api(app: tauri::State<'_, App>, cmd: String, args: Option<Value>) -> Result<Value, AppError> {
    app.dispatch(&cmd, args.unwrap_or(Value::Null)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let store = store::Store::new(dir).map_err(|e| e.message)?;
            app.manage(App::new(store, secrets::Secrets::new(KEYCHAIN_SERVICE)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api])
        .run(tauri::generate_context!())
        .expect("error while running DbOtter");
}
