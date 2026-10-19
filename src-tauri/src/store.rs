//! Saved connections (`connections.json`) and query history (`history.jsonl`) in the app's
//! data directory. Passwords are not stored here (see `secrets`).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::model::{ConnectionConfig, HistoryEntry};

/// History is trimmed back to this many entries when it grows past twice the size.
const HISTORY_KEEP: usize = 1000;
/// Longer SQL (e.g. a pasted dump) is cut in the history.
const HISTORY_SQL_MAX: usize = 100_000;

pub struct Store {
    dir: PathBuf,
    /// Serializes file writes; holds the history line count once known.
    lock: Mutex<Option<usize>>,
}

/// Write to a temp file and rename, so a crash never leaves a half-written file.
fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    fs::rename(tmp, path)
}

impl Store {
    pub fn new(dir: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&dir).map_err(|e| AppError::new(format!("Can't create {}: {e}", dir.display())))?;
        Ok(Self { dir, lock: Mutex::new(None) })
    }

    fn connections_path(&self) -> PathBuf {
        self.dir.join("connections.json")
    }

    fn history_path(&self) -> PathBuf {
        self.dir.join("history.jsonl")
    }

    pub fn connections(&self) -> AppResult<Vec<ConnectionConfig>> {
        match fs::read(self.connections_path()) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }

    pub fn connection(&self, id: &str) -> AppResult<ConnectionConfig> {
        self.connections()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or_else(|| AppError::new("Connection not found").with_code("not_found"))
    }

    /// Inserts or replaces (by id).
    pub fn upsert_connection(&self, conn: ConnectionConfig) -> AppResult<()> {
        let _guard = self.lock.lock().unwrap();
        let mut all = self.connections()?;
        match all.iter_mut().find(|c| c.id == conn.id) {
            Some(existing) => *existing = conn,
            None => all.push(conn),
        }
        write_atomic(&self.connections_path(), &serde_json::to_vec_pretty(&all)?)?;
        Ok(())
    }

    pub fn delete_connection(&self, id: &str) -> AppResult<()> {
        let _guard = self.lock.lock().unwrap();
        let all: Vec<_> = self.connections()?.into_iter().filter(|c| c.id != id).collect();
        write_atomic(&self.connections_path(), &serde_json::to_vec_pretty(&all)?)?;
        Ok(())
    }

    pub fn add_history(&self, entry: &HistoryEntry) -> AppResult<()> {
        let mut count = self.lock.lock().unwrap();
        let path = self.history_path();
        let mut entry = entry.clone();
        if entry.sql.len() > HISTORY_SQL_MAX {
            let mut cut = HISTORY_SQL_MAX;
            while !entry.sql.is_char_boundary(cut) {
                cut -= 1;
            }
            entry.sql.truncate(cut);
            entry.sql.push_str("\n-- (cut: too long for the history)");
        }
        let mut file = fs::OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(file, "{}", serde_json::to_string(&entry)?)?;
        drop(file);
        // the file is read once per run to count lines, then the count is kept here
        let n = match *count {
            Some(n) => n + 1,
            None => self.read_history_lines()?.len(),
        };
        *count = Some(n);
        if n > HISTORY_KEEP * 2 {
            let lines = self.read_history_lines()?;
            let keep = lines[lines.len().saturating_sub(HISTORY_KEEP)..].join("\n") + "\n";
            write_atomic(&path, keep.as_bytes())?;
            *count = Some(HISTORY_KEEP.min(lines.len()));
        }
        Ok(())
    }

    fn read_history_lines(&self) -> AppResult<Vec<String>> {
        match fs::read_to_string(self.history_path()) {
            Ok(text) => Ok(text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(e.into()),
        }
    }

    /// Newest first; skips lines that fail to parse.
    pub fn history(&self, limit: usize) -> AppResult<Vec<HistoryEntry>> {
        let lines = self.read_history_lines()?;
        Ok(lines.iter().rev().filter_map(|l| serde_json::from_str(l).ok()).take(limit).collect())
    }

    pub fn clear_history(&self) -> AppResult<()> {
        let mut count = self.lock.lock().unwrap();
        *count = Some(0);
        match fs::remove_file(self.history_path()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SslMode;

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("dbotter-test-{}", uuid::Uuid::new_v4()));
        Store::new(dir).unwrap()
    }

    fn conn(id: &str, name: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.into(),
            kind: Default::default(),
            name: name.into(),
            host: "localhost".into(),
            port: 5432,
            database: "db".into(),
            user: "me".into(),
            ssl_mode: SslMode::Prefer,
            save_password: false,
            color: None,
            ssl_root_cert: None,
            created_at: 0,
        }
    }

    #[test]
    fn connections_round_trip() {
        let store = temp_store();
        assert!(store.connections().unwrap().is_empty());
        store.upsert_connection(conn("a", "First")).unwrap();
        store.upsert_connection(conn("b", "Second")).unwrap();
        store.upsert_connection(conn("a", "Renamed")).unwrap();
        let all = store.connections().unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(store.connection("a").unwrap().name, "Renamed");
        store.delete_connection("a").unwrap();
        assert_eq!(store.connections().unwrap().len(), 1);
        assert!(store.connection("a").is_err());
    }

    #[test]
    fn history_newest_first_and_trimmed() {
        let store = temp_store();
        for i in 0..(HISTORY_KEEP * 2 + 5) {
            store
                .add_history(&HistoryEntry {
                    id: i.to_string(),
                    connection_id: "a".into(),
                    sql: format!("select {i}"),
                    ran_at: i as u64,
                    duration_ms: 1,
                    row_count: Some(1),
                    error: None,
                })
                .unwrap();
        }
        let h = store.history(3).unwrap();
        assert_eq!(h[0].sql, format!("select {}", HISTORY_KEEP * 2 + 4));
        assert!(store.read_history_lines().unwrap().len() <= HISTORY_KEEP * 2);
        store.clear_history().unwrap();
        assert!(store.history(10).unwrap().is_empty());
    }
}
