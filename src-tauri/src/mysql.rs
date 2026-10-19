//! MySQL and MariaDB (being implemented).

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::running::Running;

pub struct MySession {
    pub info: SessionInfo,
}

#[allow(unused_variables)]
impl MySession {
    pub async fn test(c: &ConnectionConfig, password: Option<&str>) -> AppResult<TestResult> {
        Err(AppError::new("MySQL and MariaDB support is not finished yet"))
    }

    pub async fn connect(c: &ConnectionConfig, password: Option<&str>) -> AppResult<MySession> {
        Err(AppError::new("MySQL and MariaDB support is not finished yet"))
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
