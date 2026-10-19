//! Open connections by connection id, whatever the engine. Each engine module (pg, mysql,
//! sqlite) has the same set of operations; this dispatches to them and holds what is shared:
//! cancelling, and the paging / counting SQL for table browsing.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::mysql::MySession;
use crate::pg::PgSession;
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
        let session = self.session(conn_id).await?;
        // registered before waiting for a connection, so a cancel in the meantime counts
        self.running.begin(query_id).await;
        let r = &self.running;
        each!(&*session, s => s.run(r, query_id, sql, max_rows, editor, single_statement).await)
    }

    /// Closes a query tab's own connection (the tab was closed or changed connection).
    pub async fn release_editor(&self, tab: &str) {
        let sessions: Vec<Arc<Session>> = self.sessions.read().await.values().cloned().collect();
        for s in sessions {
            each!(&*s, s => s.release_editor(tab).await);
        }
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
