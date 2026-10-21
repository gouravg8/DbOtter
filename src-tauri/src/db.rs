//! Open connections by connection id, whatever the engine. Each engine module (pg, mysql,
//! sqlite) has the same set of operations; this dispatches to them and holds what is shared:
//! cancelling, and the paging / counting SQL for table browsing.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::export::{ExportFormat, ExportResult, ExportSink};
use crate::model::*;
use crate::mysql::MySession;
use crate::pg::PgSession;
use crate::results::{Collector, Ran, Sink};
use crate::running::Running;
use crate::sqlite::LiteSession;

// one per open connection, behind an Arc: variant sizes don't matter
#[allow(clippy::large_enum_variant)]
pub enum Session {
    Postgres(PgSession),
    Mysql(MySession),
    Sqlite(LiteSession),
}

/// Calls the same method on whichever engine the session is.
macro_rules! each {
    ($session:expr, $s:ident => $body:expr) => {
        match $session {
            Session::Postgres($s) => $body,
            Session::Mysql($s) => $body,
            Session::Sqlite($s) => $body,
        }
    };
}

impl Session {
    pub fn info(&self) -> &SessionInfo {
        each!(self, s => &s.info)
    }

    fn close(&self) {
        each!(self, s => s.close())
    }
}

/// Whether `sql` tries to switch a read-only session back to writing (`SET TRANSACTION READ
/// WRITE`, `BEGIN READ WRITE`, `SET default_transaction_read_only = off`, `SET @@transaction_read_only = 0`…).
/// Looks at the words only; a string mentioning those words is refused too, which is fine here.
pub fn reenables_writes(sql: &str) -> bool {
    let words = sql.to_lowercase().split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).map(str::to_string).collect::<Vec<_>>();
    let has = |w: &str| words.iter().any(|x| x == w);
    words.windows(2).any(|p| p[0] == "read" && p[1] == "write")
        || (has("set") && ["default_transaction_read_only", "transaction_read_only", "tx_read_only"].iter().any(|v| has(v)))
}

/// "Column does not exist", per engine (Postgres SQLSTATE, MySQL error number, SQLite text).
fn is_unknown_column(e: &AppError) -> bool {
    matches!(e.code.as_deref(), Some("42703") | Some("1054")) || e.message.contains("no such column")
}

#[derive(Default)]
pub struct Db {
    sessions: RwLock<HashMap<String, Arc<Session>>>,
    /// Running queries by the UI's query id, for cancelling.
    running: Running,
}

impl Db {
    pub fn new() -> Self {
        Self::default()
    }

    /// One-off connection to check settings from the connection form.
    pub async fn test(&self, c: &ConnectionConfig, password: Option<&str>) -> AppResult<TestResult> {
        match c.kind {
            DbKind::Postgres => PgSession::test(c, password).await,
            DbKind::Mysql => MySession::test(c, password).await,
            DbKind::Sqlite => LiteSession::test(c).await,
        }
    }

    pub async fn connect(&self, c: &ConnectionConfig, password: Option<&str>) -> AppResult<SessionInfo> {
        let session = match c.kind {
            DbKind::Postgres => Session::Postgres(PgSession::connect(c, password).await?),
            DbKind::Mysql => Session::Mysql(MySession::connect(c, password).await?),
            DbKind::Sqlite => Session::Sqlite(LiteSession::connect(c).await?),
        };
        let info = session.info().clone();
        if let Some(old) = self.sessions.write().await.insert(c.id.clone(), Arc::new(session)) {
            old.close();
        }
        Ok(info)
    }

    pub async fn disconnect(&self, id: &str) {
        if let Some(s) = self.sessions.write().await.remove(id) {
            s.close();
        }
    }

    pub async fn is_connected(&self, id: &str) -> bool {
        self.sessions.read().await.contains_key(id)
    }

    async fn session(&self, id: &str) -> AppResult<Arc<Session>> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("Not connected").with_code("not_connected"))
    }

    pub async fn session_info(&self, id: &str) -> AppResult<SessionInfo> {
        Ok(self.session(id).await?.info().clone())
    }

    /// Runs `sql` (one or more statements). With `editor` (a query tab id) it runs on that
    /// tab's own connection, so transactions and session settings carry over between runs.
    /// `single_statement` refuses SQL that holds more than one statement (browse SQL that
    /// includes the user's WHERE text).
    pub async fn run(
        &self,
        conn_id: &str,
        query_id: &str,
        sql: &str,
        max_rows: usize,
        editor: Option<&str>,
        single_statement: bool,
    ) -> AppResult<QueryOutput> {
        let ran = self.run_into(conn_id, query_id, sql, Collector::new(max_rows), editor, single_statement).await?;
        ran.sink.finish(ran.outcome, ran.user_cancelled, ran.duration_ms)
    }

    /// [`Db::run`] with the rows going to `sink`.
    async fn run_into<S: Sink>(
        &self,
        conn_id: &str,
        query_id: &str,
        sql: &str,
        sink: S,
        editor: Option<&str>,
        single_statement: bool,
    ) -> AppResult<Ran<S>> {
        let session = self.session(conn_id).await?;
        if session.info().read_only && reenables_writes(sql) {
            return Err(AppError::new("This connection is read-only: statements that turn writing back on are refused")
                .with_code("read_only"));
        }
        // registered before waiting for a connection, so a cancel in the meantime counts
        self.running.begin(query_id).await;
        let r = &self.running;
        each!(&*session, s => s.run(r, query_id, sql, sink, editor, single_statement).await)
    }

    /// Writes every row of a table (with the tab's filters and sort, not just the page shown)
    /// or of a query that only reads to a file, streamed. Cancel it like a query, by
    /// `query_id`. A query from a query tab runs on that tab's connection (`editor`), so it
    /// sees what the tab's open transaction sees.
    pub async fn export(
        &self,
        conn_id: &str,
        query_id: &str,
        source: &ExportSource,
        file: ExportFile,
        editor: Option<&str>,
    ) -> AppResult<ExportResult> {
        let session = self.session(conn_id).await?;
        let dialect = session.info().kind.dialect();
        let (sql, single_statement, default_target) = match source {
            ExportSource::Table { query: q } => {
                // looked up fresh: a stale key would fail the export after the file was opened
                each!(&*session, s => s.forget_primary_key(&q.schema, &q.table).await);
                let order = match q.sort {
                    None => each!(&*session, s => s.primary_key(&q.schema, &q.table).await)?,
                    Some(_) => vec![],
                };
                let raw = q.where_raw.as_deref().is_some_and(|w| !w.trim().is_empty());
                (crate::sql::table_export(dialect, q, &order)?, raw, q.table.clone())
            }
            ExportSource::Sql { sql } => (crate::sql::read_query(dialect, sql)?.to_string(), true, "query_result".into()),
        };
        let target = file.target.as_deref().map(str::trim).filter(|t| !t.is_empty()).unwrap_or(&default_target);
        let sink = ExportSink::create(file.path, file.format, dialect, target, file.overwrite)?;
        let ran = self.run_into(conn_id, query_id, &sql, sink, editor, single_statement).await?;
        ran.sink.finish(ran.outcome, ran.duration_ms)
    }

    /// Saves rows edited in the grid, all or nothing: one UPDATE per row by its key, in one
    /// transaction on a session of its own (a query tab's open transaction isn't involved).
    /// Each key must still match exactly one row, else nothing is saved. `dry_run` only
    /// returns the statements, for review.
    pub async fn apply_edits(
        &self,
        conn_id: &str,
        query_id: &str,
        schema: &str,
        table: &str,
        edits: &[RowEdit],
        dry_run: bool,
    ) -> AppResult<EditResult> {
        let session = self.session(conn_id).await?;
        let d = session.info().kind.dialect();
        let statements = edits.iter().map(|e| crate::sql::update_row(d, schema, table, e)).collect::<AppResult<Vec<_>>>()?;
        if dry_run || edits.is_empty() {
            return Ok(EditResult { statements, saved: 0 });
        }
        if session.info().read_only {
            return Err(AppError::new("This connection is read-only").with_code("read_only"));
        }
        // a count before each UPDATE: MySQL reports 0 affected rows for an UPDATE that
        // changes nothing, so its count can't tell a missing row
        let mut batch = String::from("BEGIN;\n");
        for (e, update) in edits.iter().zip(&statements) {
            batch.push_str(&format!("{};\n{update};\n", crate::sql::count_row(d, schema, table, e)?));
        }
        let tab = format!("edit:{}", uuid::Uuid::new_v4());
        let tx = |sql: &'static str| {
            let tab = tab.clone();
            async move { self.run(conn_id, &uuid::Uuid::new_v4().to_string(), sql, 1, Some(&tab), false).await }
        };
        let saved = match self.run(conn_id, query_id, &batch, 10, Some(&tab), false).await {
            Ok(out) => {
                let counts: Vec<Option<String>> = out
                    .results
                    .iter()
                    .filter(|r| r.has_rows)
                    .map(|r| r.rows.first().and_then(|row| row.first().cloned().flatten()))
                    .collect();
                match edits.iter().zip(&counts).position(|(_, n)| n.as_deref() != Some("1")) {
                    Some(i) => Err(stale_row(&edits[i], counts[i].as_deref())),
                    None if counts.len() != edits.len() => Err(AppError::new("The database didn't confirm every change; nothing was saved")),
                    None => tx("COMMIT").await.map(|_| edits.len()),
                }
            }
            Err(e) => Err(e),
        };
        if saved.is_err() {
            let _ = tx("ROLLBACK").await;
        }
        self.release_editor(&tab).await;
        Ok(EditResult { statements, saved: saved? })
    }

    /// Closes a query tab's own connection (the tab was closed or changed connection).
    pub async fn release_editor(&self, tab: &str) {
        let sessions: Vec<Arc<Session>> = self.sessions.read().await.values().cloned().collect();
        for s in sessions {
            each!(&*s, s => s.release_editor(tab).await);
        }
    }

    /// Whether a query tab's own session is inside a transaction.
    pub async fn transaction_status(&self, conn_id: &str, tab: &str) -> AppResult<TxState> {
        let session = self.session(conn_id).await?;
        each!(&*session, s => s.transaction_status(tab).await)
    }

    /// Returns false when the query already finished.
    pub async fn cancel(&self, query_id: &str) -> AppResult<bool> {
        self.running.cancel(query_id).await
    }

    pub async fn schema(&self, conn_id: &str) -> AppResult<SchemaTree> {
        let session = self.session(conn_id).await?;
        each!(&*session, s => s.schema().await)
    }

    pub async fn structure(&self, conn_id: &str, schema: &str, table: &str) -> AppResult<TableStructure> {
        let session = self.session(conn_id).await?;
        each!(&*session, s => s.structure(schema, table).await)
    }

    pub async fn table_rows(&self, conn_id: &str, query_id: &str, q: &TableQuery) -> AppResult<TableRows> {
        let session = self.session(conn_id).await?;
        let dialect = session.info().kind.dialect();
        let primary_key = || async { each!(&*session, s => s.primary_key(&q.schema, &q.table).await) };
        // without an ORDER BY, LIMIT/OFFSET pages can repeat or skip rows
        let order = if q.sort.is_none() { primary_key().await? } else { vec![] };
        let raw = q.where_raw.as_deref().is_some_and(|w| !w.trim().is_empty());
        let sql = crate::sql::table_select(dialect, q, &order)?;
        let (sql, out) = match self.run(conn_id, query_id, &sql, q.limit as usize, None, raw).await {
            // the key changed since it was cached (renamed column, new key): look it up again
            Err(e) if is_unknown_column(&e) && !order.is_empty() => {
                each!(&*session, s => s.forget_primary_key(&q.schema, &q.table).await);
                let sql = crate::sql::table_select(dialect, q, &primary_key().await?)?;
                let out = self.run(conn_id, query_id, &sql, q.limit as usize, None, raw).await?;
                (sql, out)
            }
            other => (sql, other?),
        };
        let result = out.results.into_iter().next().unwrap_or_default();
        Ok(TableRows { sql, result, duration_ms: out.duration_ms })
    }

    pub async fn table_count(&self, conn_id: &str, query_id: &str, q: &TableQuery) -> AppResult<i64> {
        let dialect = self.session(conn_id).await?.info().kind.dialect();
        let sql = crate::sql::table_count(dialect, q)?;
        let raw = q.where_raw.as_deref().is_some_and(|w| !w.trim().is_empty());
        let out = self.run(conn_id, query_id, &sql, 1, None, raw).await?;
        out.results
            .first()
            .and_then(|r| r.rows.first())
            .and_then(|row| row.first().cloned().flatten())
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| AppError::new("Count returned no rows"))
    }
}

/// A changed row whose key no longer finds exactly one row.
fn stale_row(edit: &RowEdit, count: Option<&str>) -> AppError {
    let key: Vec<String> = edit.key.iter().map(|(c, v)| format!("{c} = {}", v.as_deref().unwrap_or("NULL"))).collect();
    let what = if count == Some("0") { "is no longer there (deleted, or its key changed)" } else { "isn't a single row any more" };
    AppError::new(format!("The row with {} {what}. Nothing was saved; refresh and try again.", key.join(", "))).with_code("stale_row")
}

/// What to export.
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ExportSource {
    Table { query: TableQuery },
    Sql { sql: String },
}

pub struct ExportFile {
    pub path: std::path::PathBuf,
    pub format: ExportFormat,
    pub overwrite: bool,
    /// Table name for SQL INSERTs (default: the table exported, or `query_result`).
    pub target: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::reenables_writes;

    #[test]
    fn spots_attempts_to_turn_writing_back_on() {
        for sql in [
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "begin read  write",
            "START TRANSACTION READ WRITE",
            "set default_transaction_read_only = off",
            "SET SESSION transaction_read_only = 0",
            "set @@tx_read_only=0",
        ] {
            assert!(reenables_writes(sql), "{sql}");
        }
        for sql in ["SELECT * FROM t", "BEGIN", "SHOW transaction_read_only", "select readwrite from t", "BEGIN READ ONLY"] {
            assert!(!reenables_writes(sql), "{sql}");
        }
    }
}
