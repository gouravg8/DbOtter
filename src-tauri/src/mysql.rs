//! MySQL and MariaDB: a small connection pool per open connection for browsing and metadata,
//! plus one dedicated connection per query tab for the user's SQL. Each database on the
//! server is a "schema" of the tree.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use mysql_async::consts::ColumnType;
use mysql_async::prelude::Queryable;
use mysql_async::{
    Column, Conn, DriverError, IoError, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, ServerError, SslOpts,
    Value,
};
use rustls::pki_types::CertificateDer;
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::results::{Collector, canceled, hex};
use crate::running::{Canceler, Running};
use crate::sql::Dialect;

const POOL_SIZE: usize = 4;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a query waits for a free pooled connection before giving up.
const POOL_WAIT: Duration = Duration::from_secs(30);
const SYSTEM_SCHEMAS: &str = "('mysql', 'information_schema', 'performance_schema', 'sys')";

const ER_ACCESS_DENIED: u16 = 1045;
const ER_PARSE_ERROR: u16 = 1064;
/// What a statement stopped by KILL QUERY fails with.
const ER_QUERY_INTERRUPTED: u16 = 1317;
/// The character set number MySQL gives binary strings (and numbers, which are not bytes).
const BINARY_CHARSET: u16 = 63;

impl From<mysql_async::Error> for AppError {
    fn from(e: mysql_async::Error) -> Self {
        use mysql_async::Error;
        match e {
            Error::Server(s) => {
                // HY000 is the "general error" state most MySQL errors carry: no information
                let detail = (!s.state.is_empty() && s.state != "HY000").then(|| format!("SQLSTATE {}", s.state));
                AppError { message: s.message, code: Some(s.code.to_string()), detail, ..Default::default() }
            }
            Error::Driver(DriverError::NoClientSslFlagFromServer) => {
                AppError::new("The server doesn't support TLS (change the SSL mode to connect without it)")
            }
            Error::Driver(d) => AppError::new(d.to_string()),
            // the library's own wrapping only adds "Input/output error:" prefixes
            Error::Io(IoError::Io(io)) => AppError::new(io.to_string()),
            Error::Io(IoError::Tls(tls)) => AppError::new(format!("TLS error: {tls}")),
            Error::Other(other) => AppError::new(other.to_string()),
            Error::Url(url) => AppError::new(url.to_string()),
        }
    }
}

/* ---------- connecting ---------- */

/// Certificates from a PEM file (like libpq's sslrootcert).
fn load_root_certs(path: &str) -> AppResult<Vec<CertificateDer<'static>>> {
    use rustls::pki_types::pem::PemObject;
    let bad = |e: &dyn std::fmt::Display| AppError::new(format!("Can't read CA certificate {path}: {e}"));
    let certs = CertificateDer::pem_file_iter(path)
        .map_err(|e| bad(&e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| bad(&e))?;
    if certs.is_empty() {
        return Err(bad(&"no certificates in the file"));
    }
    Ok(certs)
}

/// TLS settings for the SSL mode, the way libpq reads them: `prefer` and `require` encrypt but
/// accept any certificate, `verify-full` checks the chain and the host name.
fn ssl_opts(c: &ConnectionConfig) -> AppResult<Option<SslOpts>> {
    Ok(match c.ssl_mode {
        SslMode::Disable => None,
        SslMode::Prefer | SslMode::Require => Some(SslOpts::default().with_danger_accept_invalid_certs(true)),
        SslMode::VerifyFull => {
            // a CA file replaces the built-in roots, as in libpq; otherwise the system's roots
            // are added to the library's Mozilla set
            let (roots, built_in) = match c.ssl_root_cert.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
                Some(path) => (load_root_certs(path)?, false),
                None => {
                    // the library fails on a certificate rustls can't use: keep only good ones
                    let mut probe = rustls::RootCertStore::empty();
                    let native = rustls_native_certs::load_native_certs().certs;
                    (native.into_iter().filter(|cert| probe.add(cert.clone()).is_ok()).collect(), true)
                }
            };
            let roots = roots.into_iter().map(|cert| cert.to_vec().into()).collect();
            Some(SslOpts::default().with_root_certs(roots).with_disable_built_in_roots(!built_in))
        }
    })
}

fn my_opts(c: &ConnectionConfig, password: Option<&str>, ssl: Option<SslOpts>) -> Opts {
    OptsBuilder::default()
        .ip_or_hostname(c.host.clone())
        .tcp_port(c.port)
        .user(Some(c.user.clone()))
        .pass(password)
        .db_name(Some(c.database.clone()).filter(|d| !d.is_empty()))
        // on localhost the library would otherwise switch to the Unix socket, which skips TLS
        .prefer_socket(false)
        .ssl_opts(ssl)
        .connect_attribute("program_name", "DbOtter")
        // setup commands also run again after the pool resets a connection
        .setup(if c.read_only { vec!["SET SESSION TRANSACTION READ ONLY"] } else { vec![] })
        .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(0, POOL_SIZE).unwrap_or_default()))
        .into()
}

async fn open(opts: Opts) -> Result<Conn, mysql_async::Error> {
    match tokio::time::timeout(CONNECT_TIMEOUT, Conn::new(opts)).await {
        Ok(conn) => conn,
        Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "Connection timed out").into()),
    }
}

/// Opens a first connection and settles `prefer`: TLS when the server offers it, plain text
/// otherwise. Returns the options that worked, for every later connection.
async fn first_connection(c: &ConnectionConfig, password: Option<&str>) -> AppResult<(Opts, Conn)> {
    let opts = my_opts(c, password, ssl_opts(c)?);
    let conn = match open(opts.clone()).await {
        Err(mysql_async::Error::Driver(DriverError::NoClientSslFlagFromServer)) if c.ssl_mode == SslMode::Prefer => {
            let plain = my_opts(c, password, None);
            return Ok((plain.clone(), open(plain).await.map_err(|e| auth_error(e.into(), password.is_some()))?));
        }
        other => other.map_err(|e| auth_error(e.into(), password.is_some()))?,
    };
    Ok((opts, conn))
}

/// Access denied: the UI then asks for a password. MySQL gives the same error for an unknown
/// user, so that is a password problem too.
fn auth_error(e: AppError, had_password: bool) -> AppError {
    if e.code.as_deref() == Some(&ER_ACCESS_DENIED.to_string()) {
        let message = if had_password { e.message.clone() } else { "Password required".to_string() };
        AppError { message, code: Some("password_required".into()), ..e }
    } else {
        e
    }
}

fn product(version: &str) -> &'static str {
    if version.contains("MariaDB") { "MariaDB" } else { "MySQL" }
}

/* ---------- results ---------- */

/// How a result column's text-protocol bytes become display text.
#[derive(Clone, Copy)]
enum CellKind {
    Text,
    /// Binary strings, blobs and geometry: `\x` hex, as Postgres shows bytea.
    Binary,
    /// BIT(n) arrives as raw bytes: shown as n binary digits, as Postgres shows bit(n).
    Bits(usize),
}

fn cell_kind(c: &Column) -> CellKind {
    use ColumnType::*;
    match c.column_type() {
        MYSQL_TYPE_BIT => CellKind::Bits(c.column_length().clamp(1, 64) as usize),
        // numbers and JSON also report the binary character set, but arrive as text
        MYSQL_TYPE_STRING | MYSQL_TYPE_VAR_STRING | MYSQL_TYPE_VARCHAR | MYSQL_TYPE_TINY_BLOB
        | MYSQL_TYPE_MEDIUM_BLOB | MYSQL_TYPE_LONG_BLOB | MYSQL_TYPE_BLOB | MYSQL_TYPE_GEOMETRY
            if c.character_set() == BINARY_CHARSET =>
        {
            CellKind::Binary
        }
        _ => CellKind::Text,
    }
}

fn cell(value: Value, kind: CellKind) -> Option<String> {
    let bytes = match value {
        Value::NULL => return None,
        Value::Bytes(b) => b,
        // the text protocol only sends bytes; anything else came from elsewhere
        other => return Some(other.as_sql(false)),
    };
    Some(match kind {
        CellKind::Text => String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()),
        CellKind::Binary => hex(&bytes),
        CellKind::Bits(width) => {
            let n = bytes.iter().fold(0u64, |n, b| (n << 8) | u64::from(*b));
            format!("{n:0width$b}")
        }
    })
}

/// Runs `sql` with the text protocol and feeds every result into the collector: one per
/// statement, rows or an affected-row count. Returns whether every statement returned rows
/// (nothing was written).
async fn collect_results(conn: &mut Conn, sql: &str, out: &mut Collector) -> Result<bool, mysql_async::Error> {
    let mut result = conn.query_iter(sql).await?;
    let mut only_rows = true;
    loop {
        match result.columns() {
            Some(columns) if !columns.is_empty() => {
                out.columns(columns.iter().map(|c| c.name_str().into_owned()).collect());
                let kinds: Vec<CellKind> = columns.iter().map(cell_kind).collect();
                let mut count = 0u64;
                // rows past the limit are read and dropped, so the full count is known and
                // later statements run; at the end of the set this moves on to the next one
                while let Some(row) = result.next().await? {
                    count += 1;
                    if out.wants_row() {
                        out.row(row.unwrap().into_iter().zip(&kinds).map(|(v, k)| cell(v, *k)).collect());
                    }
                }
                out.complete(count);
            }
            Some(_) => {
                only_rows = false;
                out.complete(result.affected_rows());
                result.next().await?;
            }
            // done, or a later statement failed: next() returns its error
            None => {
                result.next().await?;
                return Ok(only_rows);
            }
        }
    }
}

/// MySQL refuses to prepare several statements with a syntax error at the start of the
/// second one: "… near 'DELETE FROM t; …' at line 1", right after a semicolon.
fn is_multi_statement_error(sql: &str, e: &ServerError) -> bool {
    let near = e.message.split_once("near '").and_then(|(_, rest)| rest.rsplit_once("' at line")).map(|(n, _)| n);
    e.code == ER_PARSE_ERROR
        && near.is_some_and(|near| {
            !near.is_empty() && sql.match_indices(near).any(|(i, _)| sql[..i].trim_end().ends_with(';'))
        })
}

/// SQL that includes the user's WHERE text must be one statement: MySQL refuses to prepare
/// several, so `true); DELETE …` can't sneak in whatever the quoting.
async fn check_single_statement(conn: &mut Conn, sql: &str) -> Result<(), mysql_async::Error> {
    let stmt = conn.prep(sql).await?;
    conn.close(stmt).await
}

/* ---------- metadata ---------- */

/// `pg_size_pretty`'s units and rounding, so sizes read the same for every engine.
fn size_pretty(bytes: u64) -> String {
    const LIMIT: u64 = 10 * 1024;
    if bytes < LIMIT {
        return format!("{bytes} bytes");
    }
    // in half units, to round to the nearest whole one
    let mut half = bytes >> 9;
    for unit in ["kB", "MB", "GB", "TB"] {
        if half < LIMIT * 2 - 1 {
            return format!("{} {unit}", half.div_ceil(2));
        }
        half >>= 10;
    }
    format!("{} PB", half.div_ceil(2))
}

/// COLUMN_DEFAULT as SQL. MySQL lists literals bare (`it's`, `0`) and expressions as their
/// text; MariaDB already writes SQL (`'it''s'`), with `NULL` when there is no default.
fn default_sql(value: Option<String>, data_type: &str, extra: &str, mariadb: bool) -> Option<String> {
    let v = value?;
    if mariadb {
        return (v != "NULL").then_some(v);
    }
    if extra.contains("DEFAULT_GENERATED") {
        // as SHOW CREATE TABLE writes them: CURRENT_TIMESTAMP bare, other expressions in parentheses
        return Some(if v.to_ascii_uppercase().starts_with("CURRENT_TIMESTAMP") { v } else { format!("({v})") });
    }
    let bare = matches!(
        data_type,
        "tinyint" | "smallint" | "mediumint" | "int" | "bigint" | "decimal" | "float" | "double" | "bit" | "year"
    );
    Some(if bare { v } else { Dialect::Mysql.quote_literal(&v) })
}

fn quoted_list(cols: &[String]) -> String {
    cols.iter().map(|c| Dialect::Mysql.quote_ident(c)).collect::<Vec<_>>().join(", ")
}

// information_schema rows read by structure()
/// TABLES: type, rows, data + index size, comment, view definition.
type TableRow = (String, Option<u64>, Option<u64>, Option<String>, Option<String>);
/// COLUMNS: name, full type, base type, nullable, default, primary key, comment, extra,
/// generation expression.
type ColumnRow = (String, String, String, bool, Option<String>, bool, String, String, Option<String>);
/// STATISTICS: index, unique, type, column, prefix length, collation, expression.
type IndexPartRow = (String, bool, String, Option<String>, Option<u64>, Option<String>, Option<String>);
/// Key constraint columns: name, type, column, referenced database / table / column,
/// update and delete rules.
type KeyRow = (String, String, String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);

/// Where the server keeps CHECK constraints (MySQL 8.0.16+, MariaDB 10.2+).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Checks {
    Missing,
    /// MySQL: CHECK_CONSTRAINTS has no table name; TABLE_CONSTRAINTS ties them to a table.
    BySchema,
    /// MariaDB: CHECK_CONSTRAINTS names the table.
    ByTable,
}

/// The connection a run uses: a query tab's own one, or one borrowed from the pool.
enum MyConn {
    Editor(OwnedMutexGuard<Conn>),
    Pooled(Conn),
}

impl MyConn {
    fn conn(&mut self) -> &mut Conn {
        match self {
            MyConn::Editor(c) => c,
            MyConn::Pooled(c) => c,
        }
    }
}

pub struct MySession {
    /// For browsing and metadata. User SQL never runs here, so no session state
    /// (transactions, SET, temporary tables) leaks between tabs.
    pool: Pool,
    /// What the pool connects with (TLS settled), for the query tabs' own connections.
    opts: Opts,
    /// One dedicated connection per query tab: BEGIN, UPDATE and COMMIT run one at a time
    /// all land on the same session.
    editors: Mutex<HashMap<String, Arc<Mutex<Conn>>>>,
    /// Bumped when a tab's connection is released, so a connection that was still being
    /// opened for it at the time is closed instead of kept.
    editor_gen: std::sync::Mutex<HashMap<String, u64>>,
    /// Primary keys by (database, table), for stable paging; cleared on schema reload.
    primary_keys: Mutex<HashMap<(String, String), Vec<String>>>,
    pub info: SessionInfo,
    mariadb: bool,
    checks: Checks,
    /// STATISTICS.EXPRESSION, for functional indexes (MySQL 8.0.13+).
    index_expressions: bool,
    /// MySQL 8 caches table statistics in information_schema for a day by default.
    stats_expiry: bool,
}

impl MySession {
    fn generation(&self, tab: &str) -> u64 {
        *self.editor_gen.lock().unwrap().get(tab).unwrap_or(&0)
    }

    async fn pooled(&self) -> AppResult<Conn> {
        match tokio::time::timeout(POOL_WAIT, self.pool.get_conn()).await {
            Ok(conn) => Ok(conn?),
            Err(_) => Err(AppError::new("All connections are busy (a long query in another tab?). Try again or cancel it.")),
        }
    }

    /// The query tab's own connection, opened on first use and replaced if it dropped.
    async fn editor(&self, tab: &str) -> AppResult<OwnedMutexGuard<Conn>> {
        let existing = self.editors.lock().await.get(tab).cloned();
        if let Some(slot) = existing {
            let guard = slot.lock_owned().await;
            if !guard.is_disconnected() {
                return Ok(guard);
            }
        }
        let generation = self.generation(tab);
        // not from the pool: it belongs to the tab, and the pool resets the session of
        // connections given back to it
        let conn = open(self.opts.clone()).await?;
        if self.generation(tab) != generation {
            // the tab was closed while this was being opened: don't keep it
            return Err(canceled());
        }
        let slot = Arc::new(Mutex::new(conn));
        self.editors.lock().await.insert(tab.to_string(), slot.clone());
        Ok(slot.lock_owned().await)
    }

    /// Forgets a tab's broken connection so its next run opens a new one (the session is
    /// gone either way).
    async fn drop_editor(&self, tab: &str, guard: &OwnedMutexGuard<Conn>) {
        let mut editors = self.editors.lock().await;
        if editors.get(tab).is_some_and(|slot| Arc::ptr_eq(slot, OwnedMutexGuard::mutex(guard))) {
            editors.remove(tab);
        }
    }
}

impl MySession {
    /// One-off connection to check settings from the connection form.
    pub async fn test(c: &ConnectionConfig, password: Option<&str>) -> AppResult<TestResult> {
        let started = Instant::now();
        let (_, mut conn) = first_connection(c, password).await?;
        let version: Option<String> = conn.query_first("SELECT VERSION()").await?;
        let latency_ms = started.elapsed().as_millis() as u64;
        let _ = conn.disconnect().await;
        let server_version = version.unwrap_or_default();
        Ok(TestResult { product: product(&server_version).into(), server_version, latency_ms })
    }

    pub async fn connect(c: &ConnectionConfig, password: Option<&str>) -> AppResult<MySession> {
        let (opts, mut conn) = first_connection(c, password).await?;
        let head: Option<(String, Option<String>, String)> = conn
            .query_first("SELECT VERSION(), DATABASE(), SUBSTRING_INDEX(CURRENT_USER(), '@', 1)")
            .await?;
        let (server_version, database, user) = head.unwrap_or_default();
        // information_schema differs between versions and between MySQL and MariaDB
        let features: Vec<(String, String)> = conn
            .query(
                "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = 'information_schema'
                   AND (TABLE_NAME, COLUMN_NAME) IN (('STATISTICS', 'EXPRESSION'),
                        ('CHECK_CONSTRAINTS', 'CHECK_CLAUSE'), ('CHECK_CONSTRAINTS', 'TABLE_NAME'))",
            )
            .await?;
        let has = |t: &str, c: &str| features.iter().any(|(ft, fc)| ft.eq_ignore_ascii_case(t) && fc.eq_ignore_ascii_case(c));
        let checks = match (has("CHECK_CONSTRAINTS", "CHECK_CLAUSE"), has("CHECK_CONSTRAINTS", "TABLE_NAME")) {
            (false, _) => Checks::Missing,
            (true, false) => Checks::BySchema,
            (true, true) => Checks::ByTable,
        };
        let stats_expiry: Vec<mysql_async::Row> =
            conn.query("SHOW VARIABLES LIKE 'information_schema_stats_expiry'").await?;
        let _ = conn.disconnect().await;

        let database = database.unwrap_or_default();
        let info = SessionInfo {
            kind: DbKind::Mysql,
            product: product(&server_version).into(),
            server_version,
            default_schema: database.clone(),
            database,
            user,
            read_only: c.read_only,
        };
        Ok(MySession {
            pool: Pool::new(opts.clone()),
            opts,
            editors: Mutex::new(HashMap::new()),
            editor_gen: std::sync::Mutex::new(HashMap::new()),
            primary_keys: Mutex::new(HashMap::new()),
            mariadb: info.product == "MariaDB",
            info,
            checks,
            index_expressions: has("STATISTICS", "EXPRESSION"),
            stats_expiry: !stats_expiry.is_empty(),
        })
    }
}

impl MySession {
    pub fn close(&self) {
        // disconnecting waits for the connections in use to come back: nobody needs to wait
        let pool = self.pool.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = pool.disconnect().await;
            });
        }
        // idle tab connections close now; one running a query closes when it finishes
        if let Ok(mut editors) = self.editors.try_lock() {
            editors.clear();
        }
    }

    /// Runs `sql` (one or more statements) with the text protocol, so every value arrives as
    /// MySQL's own text output. With `editor` (a query tab id) it runs on that tab's own
    /// connection, otherwise on a pooled one.
    pub async fn run(
        &self,
        running: &Running,
        query_id: &str,
        sql: &str,
        max_rows: usize,
        editor: Option<&str>,
        single_statement: bool,
    ) -> AppResult<QueryOutput> {
        let conn = match editor {
            Some(tab) => self.editor(tab).await.map(MyConn::Editor),
            None => self.pooled().await.map(MyConn::Pooled),
        };
        let mut conn = match conn {
            Ok(c) => c,
            Err(e) => {
                running.end(query_id).await;
                return Err(e);
            }
        };
        let canceler = Canceler::Mysql { pool: self.pool.clone(), connection_id: conn.conn().id() };
        running.attach(query_id, canceler).await?;
        let started = Instant::now();
        let mut out = Collector::new(max_rows);
        // the statement check runs after the cancel handle is registered, as preparing can
        // wait on table locks
        let outcome = match single_statement {
            true => check_single_statement(conn.conn(), sql).await,
            false => Ok(()),
        };
        let outcome = match outcome {
            Ok(()) => collect_results(conn.conn(), sql, &mut out).await,
            Err(e) => Err(e),
        };
        let duration_ms = started.elapsed().as_millis() as u64;
        let user_cancelled = running.end(query_id).await;
        if let (Err(e), Some(tab), MyConn::Editor(guard)) = (&outcome, editor, &conn)
            && e.is_fatal()
        {
            self.drop_editor(tab, guard).await;
        }
        let outcome = match outcome {
            // a SLEEP() stopped by KILL QUERY returns 1 instead of failing: a batch that only
            // read, cancelled by the user, reads as cancelled. One that wrote shows what it did,
            // as MySQL has no implicit transaction around a batch.
            Ok(true) if user_cancelled => Err(canceled()),
            Ok(_) => Ok(()),
            Err(mysql_async::Error::Server(e)) if e.code == ER_QUERY_INTERRUPTED && user_cancelled => Err(canceled()),
            Err(mysql_async::Error::Server(e)) if single_statement && is_multi_statement_error(sql, &e) => Err(
                AppError::new("A WHERE condition can't contain several statements (use a query tab for that)")
                    .with_code(&ER_PARSE_ERROR.to_string()),
            ),
            Err(e) => Err(e.into()),
        };
        out.finish(outcome, user_cancelled, duration_ms)
    }

    /// Closes a query tab's connection (the tab was closed).
    pub async fn release_editor(&self, tab: &str) {
        *self.editor_gen.lock().unwrap().entry(tab.to_string()).or_default() += 1;
        self.editors.lock().await.remove(tab);
    }

    pub async fn schema(&self) -> AppResult<SchemaTree> {
        self.primary_keys.lock().await.clear();
        let mut conn = self.pooled().await?;
        let schemas: Vec<String> = conn
            .exec(
                format!(
                    "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN {SYSTEM_SCHEMAS}
                     ORDER BY SCHEMA_NAME = ? DESC, SCHEMA_NAME"
                ),
                (&self.info.default_schema,),
            )
            .await?;
        let relations: Vec<(String, String, String, Option<u64>)> = conn
            .query(format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS} ORDER BY TABLE_SCHEMA, TABLE_NAME"
            ))
            .await?;
        let columns: Vec<(String, String, String, String)> = conn
            .query(format!(
                "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA NOT IN {SYSTEM_SCHEMAS} ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
            ))
            .await?;

        let mut cols: HashMap<(String, String), Vec<ColumnBrief>> = HashMap::new();
        for (schema, table, name, data_type) in columns {
            cols.entry((schema, table)).or_default().push(ColumnBrief { name, data_type });
        }
        let mut tree: Vec<SchemaNode> = schemas.into_iter().map(|name| SchemaNode { name, relations: vec![] }).collect();
        for (schema, name, kind, rows) in relations {
            let kind = if kind.contains("VIEW") { RelationKind::View } else { RelationKind::Table };
            let columns = cols.remove(&(schema.clone(), name.clone())).unwrap_or_default();
            // views have no row count
            let estimated_rows = rows.map_or(-1, |n| n as i64);
            if let Some(node) = tree.iter_mut().find(|s| s.name == schema) {
                node.relations.push(RelationNode { name, kind, estimated_rows, columns });
            }
        }
        Ok(SchemaTree { schemas: tree })
    }

    pub async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        // a structure reload (the table tab's refresh) also refreshes the cached key
        self.forget_primary_key(schema, table).await;
        let mut conn = self.pooled().await?;
        if self.stats_expiry {
            // live row count and size for this table instead of a cached day-old one (the
            // pool resets the session when the connection goes back)
            conn.query_drop("SET SESSION information_schema_stats_expiry = 0").await?;
        }
        let rel = Dialect::Mysql.qualified(schema, table);
        let key = (schema, table);
        let head: Option<TableRow> = conn
            .exec_first(
                "SELECT t.TABLE_TYPE, t.TABLE_ROWS, t.DATA_LENGTH + t.INDEX_LENGTH, t.TABLE_COMMENT, v.VIEW_DEFINITION
                 FROM information_schema.TABLES t
                 LEFT JOIN information_schema.VIEWS v ON v.TABLE_SCHEMA = t.TABLE_SCHEMA AND v.TABLE_NAME = t.TABLE_NAME
                 WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ?",
                key,
            )
            .await?;
        let (kind, rows, size, comment, definition) =
            head.ok_or_else(|| AppError::new(format!("{rel} not found")).with_code("not_found"))?;
        let view = kind.contains("VIEW");

        let columns: Vec<ColumnRow> = conn
            .exec(
                "SELECT COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE = 'YES', COLUMN_DEFAULT, COLUMN_KEY = 'PRI',
                        COLUMN_COMMENT, EXTRA, GENERATION_EXPRESSION
                 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY ORDINAL_POSITION",
                key,
            )
            .await?;
        let columns = columns
            .into_iter()
            .map(|(name, data_type, base_type, nullable, default, primary_key, comment, extra, expression)| {
                let generated = match expression.filter(|e| !e.is_empty()) {
                    Some(e) => {
                        let how = if extra.contains("STORED") { "STORED" } else { "VIRTUAL" };
                        Some(format!("GENERATED ALWAYS AS ({e}) {how}"))
                    }
                    None => extra.to_ascii_lowercase().contains("auto_increment").then(|| "AUTO_INCREMENT".into()),
                };
                ColumnInfo {
                    name,
                    data_type,
                    nullable,
                    default: if generated.is_some() { None } else { default_sql(default, &base_type, &extra, self.mariadb) },
                    generated,
                    primary_key,
                    comment: Some(comment).filter(|c| !c.is_empty()),
                }
            })
            .collect();

        let expression = if self.index_expressions { "EXPRESSION" } else { "NULL" };
        let parts: Vec<IndexPartRow> = conn
            .exec(
                format!(
                    "SELECT INDEX_NAME, NON_UNIQUE = 0, INDEX_TYPE, COLUMN_NAME, SUB_PART, COLLATION, {expression}
                     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                     ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX"
                ),
                key,
            )
            .await?;
        let mut indexes: Vec<(IndexInfo, String, Vec<String>)> = Vec::new();
        for (name, unique, index_type, column, sub_part, collation, expression) in parts {
            let mut part = match (column, expression) {
                (Some(c), _) => Dialect::Mysql.quote_ident(&c),
                (None, Some(e)) => format!("({e})"),
                (None, None) => "?".into(),
            };
            if let Some(n) = sub_part {
                part.push_str(&format!("({n})"));
            }
            if collation.as_deref() == Some("D") {
                part.push_str(" DESC");
            }
            match indexes.last_mut() {
                Some((index, _, parts)) if index.name == name => parts.push(part),
                _ => {
                    let primary = name == "PRIMARY";
                    let index = IndexInfo { name, definition: String::new(), unique, primary, size: String::new() };
                    indexes.push((index, index_type, vec![part]));
                }
            }
        }
        let indexes = indexes
            .into_iter()
            .map(|(mut index, index_type, parts)| {
                let (kind, using) = match index_type.as_str() {
                    "FULLTEXT" | "SPATIAL" => (format!("{index_type} "), String::new()),
                    other => (if index.unique { "UNIQUE " } else { "" }.to_string(), format!(" USING {other}")),
                };
                index.definition = format!(
                    "CREATE {kind}INDEX {} ON {rel} ({}){using}",
                    Dialect::Mysql.quote_ident(&index.name),
                    parts.join(", ")
                );
                index
            })
            .collect();

        let keys: Vec<KeyRow> = conn
            .exec(
                "SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
                        k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, rc.UPDATE_RULE, rc.DELETE_RULE
                 FROM information_schema.TABLE_CONSTRAINTS tc
                 JOIN information_schema.KEY_COLUMN_USAGE k
                   ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                  AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME
                 LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                   ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                  AND rc.TABLE_NAME = tc.TABLE_NAME
                 WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
                   AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
                 ORDER BY tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, k.ORDINAL_POSITION",
                key,
            )
            .await?;
        // one row per column: group them by constraint
        struct Key {
            name: String,
            kind: String,
            columns: Vec<String>,
            target: Option<(String, String)>,
            references: Vec<String>,
            rules: (Option<String>, Option<String>),
        }
        let mut grouped: Vec<Key> = Vec::new();
        for (name, kind, column, ref_schema, ref_table, ref_column, on_update, on_delete) in keys {
            if !grouped.last().is_some_and(|k| k.name == name && k.kind == kind) {
                let target = ref_schema.zip(ref_table);
                grouped.push(Key { name, kind, columns: vec![], target, references: vec![], rules: (on_update, on_delete) });
            }
            let k = grouped.last_mut().expect("pushed above");
            k.columns.push(column);
            k.references.extend(ref_column);
        }
        let mut constraints: Vec<ConstraintInfo> = grouped
            .into_iter()
            .map(|k| {
                let cols = quoted_list(&k.columns);
                let (kind, definition) = match k.kind.as_str() {
                    "PRIMARY KEY" => ("primary key", format!("PRIMARY KEY ({cols})")),
                    "UNIQUE" => ("unique", format!("UNIQUE ({cols})")),
                    _ => {
                        // the database is only named when it isn't the table's own, as SHOW CREATE TABLE does
                        let target = match &k.target {
                            Some((s, t)) if s == schema => Dialect::Mysql.quote_ident(t),
                            Some((s, t)) => Dialect::Mysql.qualified(s, t),
                            None => String::new(),
                        };
                        let mut def = format!("FOREIGN KEY ({cols}) REFERENCES {target} ({})", quoted_list(&k.references));
                        // NO ACTION is the default, left out as Postgres does
                        for (event, rule) in [("DELETE", &k.rules.1), ("UPDATE", &k.rules.0)] {
                            if let Some(rule) = rule.as_deref().filter(|r| *r != "NO ACTION") {
                                def.push_str(&format!(" ON {event} {rule}"));
                            }
                        }
                        ("foreign key", def)
                    }
                };
                ConstraintInfo { name: k.name, kind: kind.into(), definition }
            })
            .collect();

        let checks: Vec<(String, String)> = match self.checks {
            Checks::Missing => vec![],
            Checks::BySchema => {
                conn.exec(
                    "SELECT cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
                     FROM information_schema.TABLE_CONSTRAINTS tc
                     JOIN information_schema.CHECK_CONSTRAINTS cc
                       ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
                     WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'",
                    key,
                )
                .await?
            }
            Checks::ByTable => {
                conn.exec(
                    "SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS
                     WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?",
                    key,
                )
                .await?
            }
        };
        // CHECK ((`qty` > 0)), with MySQL's own parentheses inside, as SHOW CREATE TABLE writes it
        constraints.extend(checks.into_iter().map(|(name, clause)| ConstraintInfo {
            name,
            kind: "check".into(),
            definition: format!("CHECK ({clause})"),
        }));
        constraints.sort_by(|a, b| {
            let rank = |c: &ConstraintInfo| (c.kind != "primary key", c.kind != "foreign key");
            rank(a).cmp(&rank(b)).then_with(|| a.name.cmp(&b.name))
        });

        Ok(TableStructure {
            columns,
            indexes,
            constraints,
            estimated_rows: if view { -1 } else { rows.map_or(-1, |n| n as i64) },
            total_size: if view { None } else { size.map(size_pretty) },
            definition: if view { definition } else { None },
            // a view's comment is the word VIEW
            comment: if view { None } else { comment.filter(|c| !c.is_empty()) },
        })
    }

    /// Primary key columns in key order (empty for views and tables without one).
    pub async fn primary_key(&self, schema: &str, table: &str) -> AppResult<Vec<String>> {
        let key = (schema.to_string(), table.to_string());
        if let Some(pk) = self.primary_keys.lock().await.get(&key) {
            return Ok(pk.clone());
        }
        let mut conn = self.pooled().await?;
        let pk: Vec<String> = conn
            .exec(
                "SELECT COLUMN_NAME FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
                 ORDER BY SEQ_IN_INDEX",
                (schema, table),
            )
            .await?;
        self.primary_keys.lock().await.insert(key, pk.clone());
        Ok(pk)
    }

    pub async fn forget_primary_key(&self, schema: &str, table: &str) {
        self.primary_keys.lock().await.remove(&(schema.to_string(), table.to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_like_pg_size_pretty() {
        assert_eq!(size_pretty(0), "0 bytes");
        assert_eq!(size_pretty(10 * 1024 - 1), "10239 bytes");
        assert_eq!(size_pretty(10 * 1024), "10 kB");
        assert_eq!(size_pretty(16 * 1024), "16 kB");
        assert_eq!(size_pretty(24 * 1024 * 1024), "24 MB");
        assert_eq!(size_pretty(10 * 1024 * 1024 - 1024), "10239 kB");
        assert_eq!(size_pretty(10 * 1024 * 1024 - 1), "10 MB");
        assert_eq!(size_pretty(3 * 1024 * 1024 * 1024), "3072 MB");
    }

    #[test]
    fn defaults_as_sql() {
        assert_eq!(default_sql(Some("it's".into()), "varchar", "", false).unwrap(), "'it''s'");
        assert_eq!(default_sql(Some("0".into()), "tinyint", "", false).unwrap(), "0");
        assert_eq!(default_sql(Some("rand()".into()), "double", "DEFAULT_GENERATED", false).unwrap(), "(rand())");
        assert_eq!(
            default_sql(Some("CURRENT_TIMESTAMP".into()), "timestamp", "DEFAULT_GENERATED", false).unwrap(),
            "CURRENT_TIMESTAMP"
        );
        assert_eq!(default_sql(Some("NULL".into()), "varchar", "", true), None);
        assert_eq!(default_sql(None, "int", "", false), None);
    }

    #[test]
    fn spots_a_second_statement() {
        let err = |near: &str| ServerError {
            code: ER_PARSE_ERROR,
            message: format!("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '{near}' at line 1"),
            state: "42000".into(),
        };
        let sql = "SELECT * FROM t WHERE (true); DELETE FROM t; SELECT (1)";
        assert!(is_multi_statement_error(sql, &err("DELETE FROM t; SELECT (1)")));
        let sql = "SELECT * FROM t WHERE (true and)";
        assert!(!is_multi_statement_error(sql, &err(")")));
        assert!(!is_multi_statement_error("SELECT 1;", &err("")));
    }

    #[test]
    fn bits_and_binary() {
        assert_eq!(cell(Value::Bytes(vec![5]), CellKind::Bits(3)).unwrap(), "101");
        assert_eq!(cell(Value::Bytes(vec![1, 0]), CellKind::Bits(10)).unwrap(), "0100000000");
        assert_eq!(cell(Value::Bytes(vec![0xde, 0xad]), CellKind::Binary).unwrap(), "\\xdead");
        assert_eq!(cell(Value::NULL, CellKind::Text), None);
    }
}
