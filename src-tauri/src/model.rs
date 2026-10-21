//! Types shared with the UI (serialized as camelCase JSON).

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    /// Try TLS, fall back to plain text (libpq's default).
    #[default]
    Prefer,
    /// TLS without certificate verification.
    Require,
    /// TLS, certificate checked against the system roots and the host name.
    VerifyFull,
}

/// Which database engine a connection talks to.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    /// Saved connections from before other engines existed have no kind: Postgres.
    #[default]
    Postgres,
    /// MySQL and MariaDB.
    Mysql,
    /// A database file; `database` holds its path, host / port / user are unused.
    Sqlite,
}

impl DbKind {
    pub fn dialect(self) -> crate::sql::Dialect {
        match self {
            DbKind::Postgres => crate::sql::Dialect::Postgres,
            DbKind::Mysql => crate::sql::Dialect::Mysql,
            DbKind::Sqlite => crate::sql::Dialect::Sqlite,
        }
    }
}

/// A saved connection. The password is never stored here, only in the OS keychain.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    #[serde(default)]
    pub kind: DbKind,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    /// Password is kept in the OS keychain.
    #[serde(default)]
    pub save_password: bool,
    /// Accent shown next to the connection (e.g. red for production).
    #[serde(default)]
    pub color: Option<String>,
    /// PEM file of CA certificates for verify-full (instead of the system roots).
    #[serde(default)]
    pub ssl_root_cert: Option<String>,
    /// The database refuses writes on every connection of this one.
    #[serde(default)]
    pub read_only: bool,
    /// Ask before risky statements (UPDATE / DELETE without WHERE, DROP, TRUNCATE).
    #[serde(default)]
    pub production: bool,
    #[serde(default)]
    pub created_at: u64,
}

/// Connection form contents. `id` is absent for a new connection; `password: None` keeps
/// the stored one.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: Option<String>,
    #[serde(default)]
    pub kind: DbKind,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub save_password: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub ssl_root_cert: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub production: bool,
    pub password: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    /// "PostgreSQL", "MySQL", "MariaDB" or "SQLite"
    pub product: String,
    pub server_version: String,
    pub latency_ms: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub kind: DbKind,
    /// "PostgreSQL", "MySQL", "MariaDB" or "SQLite"
    pub product: String,
    pub server_version: String,
    pub database: String,
    pub user: String,
    /// Where unqualified names resolve: public, the MySQL database, or main.
    pub default_schema: String,
    pub read_only: bool,
}

/* ---------- schema ---------- */

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTree {
    pub schemas: Vec<SchemaNode>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNode {
    pub name: String,
    pub relations: Vec<RelationNode>,
}

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RelationKind {
    Table,
    View,
    MaterializedView,
    ForeignTable,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelationNode {
    pub name: String,
    pub kind: RelationKind,
    /// From planner statistics; -1 when the table was never analyzed.
    pub estimated_rows: i64,
    /// Name and type, for autocomplete.
    pub columns: Vec<ColumnBrief>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnBrief {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub estimated_rows: i64,
    /// Human readable, e.g. "24 MB" (tables and materialized views only).
    pub total_size: Option<String>,
    /// For views and materialized views.
    pub definition: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    /// "GENERATED ALWAYS AS (…) STORED" or an identity clause.
    pub generated: Option<String>,
    pub primary_key: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
    pub size: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintInfo {
    pub name: String,
    /// "primary key", "foreign key", "unique", "check", "exclusion"
    pub kind: String,
    pub definition: String,
}

/* ---------- data ---------- */

/// One result of a statement: rows as text (Postgres text format), NULL as `None`.
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Rows returned or affected, from the command tag.
    pub row_count: u64,
    /// The statement returns rows (SELECT, RETURNING…) as opposed to only a count.
    pub has_rows: bool,
    /// Stopped at the row limit; the remaining rows were not fetched.
    pub truncated: bool,
}

/// Where a query tab's own session stands.
#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TxState {
    /// The tab has no session of its own (nothing ran yet, or it was released).
    None,
    Idle,
    /// Inside BEGIN … : changes wait for COMMIT.
    Open,
    /// Postgres: a statement failed inside the transaction; only ROLLBACK works now.
    Aborted,
    /// The server can't tell (MySQL without performance_schema).
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutput {
    pub results: Vec<ResultSet>,
    pub duration_ms: u64,
    /// Cancelled after the row limit was reached: the kept rows are shown, but the rest of
    /// the batch didn't run (and an open transaction in the tab is now aborted).
    pub canceled: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub column: String,
    /// "=", "!=", "<", ">", "<=", ">=", "contains", "not contains", "starts with",
    /// "is null", "is not null"
    pub op: String,
    #[serde(default)]
    pub value: String,
    /// Compare the column as text (for types without an = operator, like json).
    #[serde(default)]
    pub as_text: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    pub column: String,
    pub desc: bool,
}

/// One row changed in the grid: the values that find it (its primary key, as loaded) and
/// the new values, `None` for NULL.
#[derive(Debug, Clone, Deserialize)]
pub struct RowEdit {
    pub key: Vec<(String, Option<String>)>,
    pub set: Vec<(String, Option<String>)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    /// The UPDATE statements, in order (for review, or as run).
    pub statements: Vec<String>,
    /// Rows saved; 0 for a dry run.
    pub saved: usize,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TableQuery {
    pub schema: String,
    pub table: String,
    pub limit: u32,
    pub offset: u64,
    pub sort: Option<Sort>,
    #[serde(default)]
    pub filters: Vec<Filter>,
    /// Extra condition typed by the user, ANDed with the filters.
    pub where_raw: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRows {
    /// The SELECT that produced the page, so the UI can show or copy it.
    pub sql: String,
    pub result: ResultSet,
    pub duration_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub sql: String,
    pub ran_at: u64,
    pub duration_ms: u64,
    pub row_count: Option<u64>,
    pub error: Option<String>,
}
