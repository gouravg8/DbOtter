//! SQLite (being implemented).

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::running::Running;

pub struct LiteSession {
    pub info: SessionInfo,
}

#[allow(unused_variables)]
impl LiteSession {
    pub async fn test(c: &ConnectionConfig) -> AppResult<TestResult> {
        Err(AppError::new("SQLite support is not finished yet"))
    }

    pub async fn connect(c: &ConnectionConfig) -> AppResult<LiteSession> {
        Err(AppError::new("SQLite support is not finished yet"))
    }

    pub fn close(&self) {}

    pub async fn run(
        &self,
        running: &Running,
        query_id: &str,
        sql: &str,
        max_rows: usize,
        editor: Option<&str>,
        single_statement: bool,
    ) -> AppResult<QueryOutput> {
        running.end(query_id).await;
        Err(AppError::new("not implemented"))
    }

    pub async fn release_editor(&self, tab: &str) {}

    pub async fn schema(&self) -> AppResult<SchemaTree> {
        Err(AppError::new("not implemented"))
    }

    pub async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        Err(AppError::new("not implemented"))
    }

    pub async fn primary_key(&self, schema: &str, table: &str) -> AppResult<Vec<String>> {
        Ok(vec![])
    }

    pub async fn forget_primary_key(&self, schema: &str, table: &str) {}
}
