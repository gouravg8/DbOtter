//! SQLite: one shared connection to the file for browsing and metadata, plus one dedicated
//! connection per query tab for the user's SQL. Every SQLite call blocks, so it runs on
//! tokio's blocking pool, holding the connection's lock for the duration.

use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_int};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::types::ValueRef;
use rusqlite::{Batch, Connection, ErrorCode, InterruptHandle, OpenFlags, OptionalExtension, ffi};
use tokio::sync::{Mutex, OwnedMutexGuard};

use crate::error::{AppError, AppResult};
use crate::model::*;
use crate::results::{Literal, Ran, Sink, canceled, hex};
use crate::running::{Canceler, Running};
use crate::sql::Dialect;

/// How long a statement waits for another connection's lock on the file (another tab's
/// open transaction, another program) before failing with SQLITE_BUSY.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a browse or metadata call waits for the shared connection.
const SHARED_WAIT: Duration = Duration::from_secs(30);

/* ---------- errors ---------- */

/// SQLite's name for a (possibly extended) result code, e.g. SQLITE_CONSTRAINT_UNIQUE.
fn code_name(code: c_int) -> Option<&'static str> {
    macro_rules! names {
        ($($name:ident),* $(,)?) => {
            match code {
                $(ffi::$name => Some(stringify!($name)),)*
                _ => None,
            }
        };
    }
    names!(
        SQLITE_ERROR, SQLITE_INTERNAL, SQLITE_PERM, SQLITE_ABORT, SQLITE_BUSY, SQLITE_LOCKED,
        SQLITE_NOMEM, SQLITE_READONLY, SQLITE_INTERRUPT, SQLITE_IOERR, SQLITE_CORRUPT, SQLITE_NOTFOUND,
        SQLITE_FULL, SQLITE_CANTOPEN, SQLITE_PROTOCOL, SQLITE_SCHEMA, SQLITE_TOOBIG, SQLITE_CONSTRAINT,
        SQLITE_MISMATCH, SQLITE_MISUSE, SQLITE_AUTH, SQLITE_RANGE, SQLITE_NOTADB,
        SQLITE_ERROR_MISSING_COLLSEQ, SQLITE_ERROR_RETRY, SQLITE_ERROR_SNAPSHOT,
        SQLITE_ABORT_ROLLBACK, SQLITE_BUSY_RECOVERY, SQLITE_BUSY_SNAPSHOT, SQLITE_BUSY_TIMEOUT,
        SQLITE_LOCKED_SHAREDCACHE, SQLITE_LOCKED_VTAB, SQLITE_READONLY_RECOVERY,
        SQLITE_READONLY_CANTLOCK, SQLITE_READONLY_ROLLBACK, SQLITE_READONLY_DBMOVED,
        SQLITE_READONLY_CANTINIT, SQLITE_READONLY_DIRECTORY, SQLITE_CANTOPEN_ISDIR,
        SQLITE_CANTOPEN_FULLPATH, SQLITE_CANTOPEN_CONVPATH, SQLITE_CANTOPEN_SYMLINK,
        SQLITE_CORRUPT_VTAB, SQLITE_CORRUPT_SEQUENCE, SQLITE_CORRUPT_INDEX, SQLITE_IOERR_READ,
        SQLITE_IOERR_SHORT_READ, SQLITE_IOERR_WRITE, SQLITE_IOERR_FSYNC, SQLITE_IOERR_LOCK,
        SQLITE_IOERR_NOMEM, SQLITE_IOERR_ACCESS, SQLITE_CONSTRAINT_CHECK,
        SQLITE_CONSTRAINT_COMMITHOOK, SQLITE_CONSTRAINT_FOREIGNKEY, SQLITE_CONSTRAINT_FUNCTION,
        SQLITE_CONSTRAINT_NOTNULL, SQLITE_CONSTRAINT_PRIMARYKEY, SQLITE_CONSTRAINT_TRIGGER,
        SQLITE_CONSTRAINT_UNIQUE, SQLITE_CONSTRAINT_VTAB, SQLITE_CONSTRAINT_ROWID,
        SQLITE_CONSTRAINT_PINNED, SQLITE_CONSTRAINT_DATATYPE,
    )
}

fn failure(e: &ffi::Error, message: Option<String>) -> AppError {
    if e.code == ErrorCode::OperationInterrupted {
        return canceled();
    }
    let code = code_name(e.extended_code).map_or_else(|| e.extended_code.to_string(), str::to_string);
    AppError::new(message.unwrap_or_else(|| e.to_string())).with_code(&code)
}

// Lives here rather than in error.rs so the SQLite engine stays in one file.
impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::SqliteFailure(e, message) => failure(&e, message),
            rusqlite::Error::SqlInputError { error, msg, .. } => failure(&error, Some(msg)),
            other => AppError::new(other.to_string()),
        }
    }
}

/// Like `From`, plus the position of the bad token in `sql`. Batch reports the offset into
/// the statement being prepared, which is the rest of `sql` from that statement on.
fn run_error(e: rusqlite::Error, sql: &str) -> AppError {
    if let rusqlite::Error::SqlInputError { error, msg, sql: rest, offset } = &e {
        let mut err = failure(error, Some(msg.clone()));
        let at = sql.len().checked_sub(rest.len()).zip(usize::try_from(*offset).ok()).map(|(base, o)| base + o);
        if let Some(at) = at.filter(|&at| sql.is_char_boundary(at)) {
            err.position = Some(sql[..at].chars().count() as u32 + 1);
        }
        return err;
    }
    e.into()
}

/* ---------- connections ---------- */

/// `~/` is the home directory, as in a shell.
fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    match (path.strip_prefix("~/").or(if path == "~" { Some("") } else { None }), home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

fn file_path(database: &str) -> AppResult<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let path = expand_home(database.trim(), home.as_deref());
    // READ_WRITE without CREATE fails on a missing file too, but only as "unable to open"
    if !path.exists() {
        return Err(AppError::new(format!("Database file not found: {}", path.display())).with_code("not_found"));
    }
    Ok(path)
}

/// Opens an existing file; never creates one (a typo in the path must not leave an empty
/// database behind). foreign_keys stays at the library default. `read_only` opens the file
/// read-only, so SQLite itself refuses every write (attached files included).
fn open(path: &Path, read_only: bool) -> AppResult<Connection> {
    let mode = if read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE };
    let flags = mode | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let db = Connection::open_with_flags(path, flags).map_err(|e| {
        let e = AppError::from(e);
        AppError { message: format!("Can't open {}: {}", path.display(), e.message), ..e }
    })?;
    db.busy_timeout(BUSY_TIMEOUT)?;
    Ok(db)
}

fn sqlite_version(db: &Connection) -> AppResult<String> {
    Ok(db.query_row("SELECT sqlite_version()", [], |r| r.get(0))?)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| AppError::new(format!("SQLite task failed: {e}")))?
}

/// A connection with its interrupt handle, kept outside the lock so a cancel never waits
/// for the query it is stopping.
#[derive(Clone)]
struct Conn {
    db: Arc<Mutex<Connection>>,
    interrupt: Arc<InterruptHandle>,
}

impl Conn {
    /// `strict_quotes`: a double-quoted name that matches no column is an error rather than
    /// SQLite's legacy fallback to a string literal. On for the browse connection, where every
    /// name is quoted by us: `ORDER BY "id"` after the column was renamed must fail (and be
    /// retried with the new key), not silently sort by the constant 'id'. Query tabs keep the
    /// file's usual behavior for the user's own SQL.
    async fn open(path: PathBuf, read_only: bool, strict_quotes: bool) -> AppResult<Conn> {
        let db = blocking(move || {
            let db = open(&path, read_only)?;
            if strict_quotes {
                db.set_db_config(rusqlite::config::DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
            }
            Ok(db)
        })
        .await?;
        let interrupt = Arc::new(db.get_interrupt_handle());
        Ok(Conn { db: Arc::new(Mutex::new(db)), interrupt })
    }
}

/* ---------- values ---------- */

/// A REAL as SQLite itself prints it (CAST(x AS TEXT), the sqlite3 shell): its own printf
/// with the default 17-digit rounding, e.g. 1.0, 0.1, 1.0e+20.
fn real(f: f64) -> String {
    let mut buf = [0 as c_char; 64];
    // SAFETY: sqlite3_snprintf writes at most buf.len() bytes, always NUL-terminated, and the
    // format consumes exactly the one double passed.
    unsafe {
        ffi::sqlite3_snprintf(buf.len() as c_int, buf.as_mut_ptr(), c"%!.17g".as_ptr(), f);
        CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned()
    }
}

fn text(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(real(f)),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Some(hex(b)),
    }
}

/// Runs each statement of `sql` in order, rows into `out`.
fn run_batch(db: &Connection, sql: &str, single_statement: bool, out: &mut impl Sink) -> AppResult<()> {
    // SQL that includes the user's WHERE text must be one statement, so `true); DELETE …`
    // can't sneak in whatever the quoting
    if single_statement {
        let mut check = Batch::new(db, sql);
        check.next().map_err(|e| run_error(e, sql))?;
        // anything after the first statement, even one that doesn't compile, is refused
        if !matches!(check.next(), Ok(None)) {
            return Err(AppError::new("A WHERE condition can't contain several statements (use a query tab for that)")
                .with_code("SQLITE_ERROR"));
        }
    }
    let mut batch = Batch::new(db, sql);
    while let Some(mut stmt) = batch.next().map_err(|e| run_error(e, sql))? {
        let width = stmt.column_count();
        if width == 0 {
            // changes() keeps the last INSERT / UPDATE / DELETE's count through other
            // statements: only report it when this statement changed something
            let before = db.total_changes();
            stmt.raw_execute()?;
            out.complete(if db.total_changes() != before { db.changes() } else { 0 });
            continue;
        }
        out.columns(stmt.column_names().into_iter().map(str::to_string).collect());
        let mut rows = stmt.raw_query();
        let mut count = 0;
        // values have a type each, not per column
        let mut forms = Vec::with_capacity(width);
        while let Some(row) = rows.next()? {
            count += 1;
            if out.wants_row() {
                forms.clear();
                let cells = (0..width)
                    .map(|i| {
                        let v = row.get_ref(i)?;
                        forms.push(match v {
                            ValueRef::Integer(_) | ValueRef::Real(_) => Literal::Number,
                            ValueRef::Blob(_) => Literal::Hex,
                            _ => Literal::Text,
                        });
                        Ok(text(v))
                    })
                    .collect::<Result<_, rusqlite::Error>>()?;
                out.row_with(cells, &forms);
            }
        }
        // the full count, also past the row limit
        out.complete(count);
    }
    Ok(())
}

/* ---------- structure helpers ---------- */

/// An identifier as written in a definition: bare when it can be, quoted otherwise.
fn ident(name: &str) -> String {
    let plain = name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    // SAFETY: SQLite reads exactly `name.len()` bytes of the string.
    if plain && unsafe { ffi::sqlite3_keyword_check(name.as_ptr().cast(), name.len() as c_int) } == 0 {
        name.to_string()
    } else {
        Dialect::Sqlite.quote_ident(name)
    }
}

fn ident_list<S: AsRef<str>>(names: &[S]) -> String {
    names.iter().map(|n| ident(n.as_ref())).collect::<Vec<_>>().join(", ")
}

/// Like pg_size_pretty: bytes up to 10 kB, then the largest unit that keeps 2+ digits.
fn pretty_size(bytes: i64) -> String {
    let (mut n, mut unit) = (bytes, "bytes");
    for next in ["kB", "MB", "GB", "TB"] {
        if n < 10 * 1024 {
            break;
        }
        n = (n + 512) / 1024;
        unit = next;
    }
    format!("{n} {unit}")
}

#[derive(Clone, Copy, PartialEq)]
enum Tok {
    Word,
    Quoted,
    Open,
    Close,
    Comma,
    Other,
}

/// SQL tokens as (kind, start, end) byte ranges, comments and whitespace dropped.
fn tokens(sql: &str) -> Vec<(Tok, usize, usize)> {
    let b = sql.as_bytes();
    let find = |from: usize, pat: &[u8]| b[from.min(b.len())..].windows(pat.len()).position(|w| w == pat).map(|p| p + from);
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        let tok = match b[i] {
            c if c.is_ascii_whitespace() => {
                i += 1;
                continue;
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                i = find(i, b"\n").map_or(b.len(), |p| p + 1);
                continue;
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i = find(i + 2, b"*/").map_or(b.len(), |p| p + 2);
                continue;
            }
            q @ (b'\'' | b'"' | b'`') => {
                i += 1;
                // a doubled quote is part of the name or string
                while i < b.len() && !(b[i] == q && b.get(i + 1) != Some(&q)) {
                    i += if b[i] == q { 2 } else { 1 };
                }
                i = (i + 1).min(b.len());
                Tok::Quoted
            }
            b'[' => {
                i = find(i, b"]").map_or(b.len(), |p| p + 1);
                Tok::Quoted
            }
            b'(' | b')' | b',' => {
                i += 1;
                match b[start] {
                    b'(' => Tok::Open,
                    b')' => Tok::Close,
                    _ => Tok::Comma,
                }
            }
            c if c.is_ascii_alphanumeric() || c == b'_' || c >= 0x80 => {
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$' || b[i] >= 0x80) {
                    i += 1;
                }
                Tok::Word
            }
            _ => {
                i += 1;
                Tok::Other
            }
        };
        out.push((tok, start, i));
    }
    out
}

fn unquote(token: &str) -> String {
    match token.as_bytes().first() {
        Some(&q @ (b'"' | b'`' | b'\'')) if token.len() >= 2 => {
            let q = q as char;
            token[1..token.len() - 1].replace(&format!("{q}{q}"), &q.to_string())
        }
        Some(b'[') if token.len() >= 2 => token[1..token.len() - 1].to_string(),
        _ => token.to_string(),
    }
}

/// The expression of generated column `column` in a CREATE TABLE: `name … AS (expr)`.
/// SQLite doesn't expose it anywhere else.
fn generated_expr(create: &str, column: &str) -> Option<String> {
    let toks = tokens(create);
    let text = |t: &(Tok, usize, usize)| &create[t.1..t.2];
    // the AS ( … ) at the top level of one column definition
    let expr_of = |def: &[(Tok, usize, usize)]| -> Option<String> {
        let name = def.first().filter(|t| matches!(t.0, Tok::Word | Tok::Quoted))?;
        if !unquote(text(name)).eq_ignore_ascii_case(column) {
            return None;
        }
        let mut depth = 0;
        for (k, t) in def.iter().enumerate() {
            match t.0 {
                Tok::Open => depth += 1,
                Tok::Close => depth -= 1,
                Tok::Word if depth == 0 && text(t).eq_ignore_ascii_case("AS") && def.get(k + 1)?.0 == Tok::Open => {
                    let open = &def[k + 1];
                    let mut inner = 0;
                    let close = def[k + 2..].iter().find(|t| {
                        match t.0 {
                            Tok::Open => inner += 1,
                            Tok::Close if inner == 0 => return true,
                            Tok::Close => inner -= 1,
                            _ => {}
                        }
                        false
                    })?;
                    return Some(create[open.2..close.1].trim().to_string());
                }
                _ => {}
            }
        }
        None
    };
    let open = toks.iter().position(|t| t.0 == Tok::Open)?;
    let (mut depth, mut def_start) = (0, open + 1);
    for (k, t) in toks.iter().enumerate().skip(open + 1) {
        match t.0 {
            Tok::Open => depth += 1,
            Tok::Close if depth > 0 => depth -= 1,
            Tok::Comma | Tok::Close if depth == 0 => {
                if let Some(expr) = expr_of(&toks[def_start..k]) {
                    return Some(expr);
                }
                if t.0 == Tok::Close {
                    return None;
                }
                def_start = k + 1;
            }
            _ => {}
        }
    }
    None
}

/// What pragma_table_list says about a table or view; None when it doesn't exist.
fn relation_kind(db: &Connection, schema: &str, table: &str) -> AppResult<Option<(String, bool)>> {
    Ok(db
        .query_row(
            "SELECT type, wr FROM pragma_table_list WHERE schema = ?1 AND name = ?2",
            [schema, table],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// (name, declared type, not null, default, pk position, hidden) per column. `hidden` is 2
/// for a virtual generated column and 3 for a stored one.
type XInfo = (String, String, bool, Option<String>, i64, i64);

fn table_xinfo(db: &Connection, schema: &str, table: &str) -> AppResult<Vec<XInfo>> {
    let mut stmt = db.prepare(
        // hidden = 1: a virtual table's hidden columns, not part of SELECT *
        "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?1, ?2)
         WHERE hidden <> 1 ORDER BY cid",
    )?;
    let rows = stmt.query_map([table, schema], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn pk_columns(columns: &[XInfo]) -> Vec<String> {
    let mut pk: Vec<&XInfo> = columns.iter().filter(|c| c.4 > 0).collect();
    pk.sort_by_key(|c| c.4);
    pk.into_iter().map(|c| c.0.clone()).collect()
}

fn structure_of(db: &Connection, schema: &str, table: &str) -> AppResult<TableStructure> {
    let rel = Dialect::Sqlite.qualified(schema, table);
    let not_found = || AppError::new(format!("{rel} not found")).with_code("not_found");
    let Some((kind, without_rowid)) = relation_kind(db, schema, table)? else { return Err(not_found()) };
    let qs = Dialect::Sqlite.quote_ident(schema);
    let create: Option<String> = db
        .query_row(&format!("SELECT sql FROM {qs}.sqlite_schema WHERE name = ?1 AND type IN ('table', 'view')"), [table], |r| {
            r.get(0)
        })
        .optional()?
        .flatten();
    let xinfo = table_xinfo(db, schema, table)?;
    let pk = pk_columns(&xinfo);
    // an INTEGER PRIMARY KEY is the rowid, never NULL; other key columns of a rowid table
    // accept NULL unless declared NOT NULL (an old SQLite quirk), WITHOUT ROWID ones don't
    let rowid_alias = !without_rowid && pk.len() == 1;
    let columns = xinfo
        .iter()
        .map(|(name, data_type, not_null, default, pk_pos, hidden)| {
            let key = *pk_pos > 0;
            let integer_key = rowid_alias && key && data_type.eq_ignore_ascii_case("INTEGER");
            let storage = if *hidden == 3 { "STORED" } else { "VIRTUAL" };
            ColumnInfo {
                name: name.clone(),
                data_type: data_type.clone(),
                nullable: !(*not_null || integer_key || (key && without_rowid)),
                default: default.clone(),
                generated: matches!(hidden, 2 | 3).then(|| {
                    match create.as_deref().and_then(|sql| generated_expr(sql, name)) {
                        Some(expr) => format!("GENERATED ALWAYS AS ({expr}) {storage}"),
                        None => format!("GENERATED ({})", storage.to_lowercase()),
                    }
                }),
                primary_key: key,
                comment: None,
            }
        })
        .collect();

    let (mut indexes, mut constraints, mut total_size) = (Vec::new(), Vec::new(), None);
    if kind != "view" {
        if !pk.is_empty() {
            constraints.push(ConstraintInfo {
                name: pk.join(", "),
                kind: "primary key".into(),
                definition: format!("PRIMARY KEY ({})", ident_list(&pk)),
            });
        }
        let list: Vec<(String, bool, String)> = db
            .prepare("SELECT name, \"unique\", origin FROM pragma_index_list(?1, ?2)")?
            .query_map([table, schema], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        let mut unique = Vec::new();
        for (name, is_unique, origin) in list {
            let cols: Vec<String> = db
                .prepare("SELECT coalesce(name, '<expression>') FROM pragma_index_info(?1, ?2) ORDER BY seqno")?
                .query_map([name.as_str(), schema], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            // indexes SQLite made for a PRIMARY KEY or UNIQUE constraint have no SQL
            let definition = match origin.as_str() {
                "pk" => format!("PRIMARY KEY ({})", ident_list(&cols)),
                "u" => format!("UNIQUE ({})", ident_list(&cols)),
                _ => db
                    .query_row(&format!("SELECT sql FROM {qs}.sqlite_schema WHERE type = 'index' AND name = ?1"), [&name], |r| {
                        r.get::<_, Option<String>>(0)
                    })
                    .optional()?
                    .flatten()
                    .unwrap_or_default(),
            };
            if origin == "u" {
                unique.push(ConstraintInfo { name: cols.join(", "), kind: "unique".into(), definition: definition.clone() });
            }
            indexes.push(IndexInfo { name, definition, unique: is_unique, primary: origin == "pk", size: String::new() });
        }
        indexes.sort_by(|a, b| b.primary.cmp(&a.primary).then_with(|| a.name.cmp(&b.name)));

        // one row per column pair, grouped by constraint id
        let fks: Vec<(i64, String, String, Option<String>, String, String)> = db
            .prepare(
                "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1, ?2)
                 ORDER BY id, seq",
            )?
            .query_map([table, schema], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
            .collect::<Result<_, _>>()?;
        for group in fks.chunk_by(|a, b| a.0 == b.0) {
            let (_, parent, _, _, on_update, on_delete) = &group[0];
            let from: Vec<&str> = group.iter().map(|f| f.2.as_str()).collect();
            // no `to`: the parent's primary key
            let to: Vec<&str> = group.iter().filter_map(|f| f.3.as_deref()).collect();
            let mut definition = format!("FOREIGN KEY ({}) REFERENCES {}", ident_list(&from), ident(parent));
            if !to.is_empty() {
                definition.push_str(&format!(" ({})", ident_list(&to)));
            }
            for (event, action) in [("UPDATE", on_update), ("DELETE", on_delete)] {
                if action != "NO ACTION" {
                    definition.push_str(&format!(" ON {event} {action}"));
                }
            }
            constraints.push(ConstraintInfo { name: from.join(", "), kind: "foreign key".into(), definition });
        }
        unique.sort_by(|a, b| a.name.cmp(&b.name));
        constraints.extend(unique);

        // dbstat is a compile-time option: without it, no size
        total_size = db
            .query_row(
                &format!(
                    "SELECT sum(pgsize) FROM dbstat({}, 1)
                     WHERE name IN (SELECT name FROM {qs}.sqlite_schema WHERE tbl_name = ?1)",
                    Dialect::Sqlite.quote_literal(schema)
                ),
                [table],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten()
            .map(pretty_size);
    }
    Ok(TableStructure { columns, indexes, constraints, estimated_rows: -1, total_size, definition: create, comment: None })
}

pub struct LiteSession {
    path: PathBuf,
    /// For browsing and metadata. User SQL from query tabs never runs here, so a tab's open
    /// transaction can't hold up browsing.
    shared: Conn,
    /// One dedicated connection per query tab: BEGIN, INSERT and COMMIT run one at a time
    /// all land on the same connection.
    editors: Mutex<HashMap<String, Conn>>,
    /// Bumped when a tab's connection is released, so a connection that was still being
    /// opened for it at the time is closed instead of kept.
    editor_gen: std::sync::Mutex<HashMap<String, u64>>,
    /// Primary keys by (schema, table), for stable paging; cleared on schema reload.
    primary_keys: Mutex<HashMap<(String, String), Vec<String>>>,
    pub info: SessionInfo,
}

impl LiteSession {
    fn generation(&self, tab: &str) -> u64 {
        *self.editor_gen.lock().unwrap().get(tab).unwrap_or(&0)
    }

    async fn lock_shared(&self) -> AppResult<OwnedMutexGuard<Connection>> {
        tokio::time::timeout(SHARED_WAIT, self.shared.db.clone().lock_owned())
            .await
            .map_err(|_| AppError::new("The connection is busy (a long query in another tab?). Try again or cancel it."))
    }

    /// Runs `f` on the shared connection.
    async fn meta<T: Send + 'static>(&self, f: impl FnOnce(&Connection) -> AppResult<T> + Send + 'static) -> AppResult<T> {
        let db = self.lock_shared().await?;
        blocking(move || f(&db)).await
    }

    /// The query tab's own connection, opened on first use.
    async fn editor(&self, tab: &str) -> AppResult<Conn> {
        if let Some(conn) = self.editors.lock().await.get(tab) {
            return Ok(conn.clone());
        }
        let generation = self.generation(tab);
        let conn = Conn::open(self.path.clone(), self.info.read_only, false).await?;
        if self.generation(tab) != generation {
            // the tab was closed while this was being opened: don't keep it
            return Err(canceled());
        }
        // two first runs racing in one tab: both use whichever got in first
        Ok(self.editors.lock().await.entry(tab.to_string()).or_insert(conn).clone())
    }
}

impl LiteSession {
    /// Opens the file once to check the path from the connection form.
    pub async fn test(c: &ConnectionConfig) -> AppResult<TestResult> {
        let started = Instant::now();
        let path = file_path(&c.database)?;
        let read_only = c.read_only;
        let server_version = blocking(move || sqlite_version(&open(&path, read_only)?)).await?;
        Ok(TestResult { product: "SQLite".into(), server_version, latency_ms: started.elapsed().as_millis() as u64 })
    }

    pub async fn connect(c: &ConnectionConfig) -> AppResult<LiteSession> {
        let path = file_path(&c.database)?;
        let shared = Conn::open(path.clone(), c.read_only, true).await?;
        let db = shared.db.clone().lock_owned().await;
        let server_version = blocking(move || sqlite_version(&db)).await?;
        let info = SessionInfo {
            kind: DbKind::Sqlite,
            product: "SQLite".into(),
            server_version,
            database: path.display().to_string(),
            user: String::new(),
            default_schema: "main".into(),
            read_only: c.read_only,
        };
        Ok(LiteSession {
            path,
            shared,
            editors: Mutex::new(HashMap::new()),
            editor_gen: std::sync::Mutex::new(HashMap::new()),
            primary_keys: Mutex::new(HashMap::new()),
            info,
        })
    }

    /// Nothing to do: the connections close when the last run using them is over and the
    /// session is dropped.
    pub fn close(&self) {}

    /// Runs `sql` (one or more statements). With `editor` (a query tab id) it runs on that
    /// tab's own connection, otherwise on the shared one.
    pub async fn run<S: Sink>(
        &self,
        running: &Running,
        query_id: &str,
        sql: &str,
        mut out: S,
        editor: Option<&str>,
        single_statement: bool,
    ) -> AppResult<Ran<S>> {
        let conn = match editor {
            Some(tab) => self.editor(tab).await,
            None => Ok(self.shared.clone()),
        };
        // a tab runs one query at a time, like a Postgres connection
        let db = match conn {
            Ok(conn) if editor.is_some() => Ok((conn.db.clone().lock_owned().await, conn.interrupt)),
            Ok(conn) => self.lock_shared().await.map(|db| (db, conn.interrupt)),
            Err(e) => Err(e),
        };
        let (db, interrupt) = match db {
            Ok(d) => d,
            Err(e) => {
                running.end(query_id).await;
                return Err(e);
            }
        };
        running.attach(query_id, Canceler::Sqlite(interrupt)).await?;
        let started = Instant::now();
        let sql = sql.to_string();
        let joined = tokio::task::spawn_blocking(move || {
            let outcome = run_batch(&db, &sql, single_statement, &mut out);
            (out, outcome)
        })
        .await;
        let duration_ms = started.elapsed().as_millis() as u64;
        let user_cancelled = running.end(query_id).await;
        let (sink, outcome) = joined.map_err(|e| AppError::new(format!("SQLite task failed: {e}")))?;
        Ok(Ran { sink, outcome, user_cancelled, duration_ms })
    }

    pub async fn transaction_status(&self, tab: &str) -> AppResult<TxState> {
        let Some(conn) = self.editors.lock().await.get(tab).cloned() else { return Ok(TxState::None) };
        let db = conn.db.lock_owned().await;
        blocking(move || Ok(if db.is_autocommit() { TxState::Idle } else { TxState::Open })).await
    }

    /// Closes a query tab's connection (the tab was closed). An open transaction in it is
    /// rolled back.
    pub async fn release_editor(&self, tab: &str) {
        *self.editor_gen.lock().unwrap().entry(tab.to_string()).or_default() += 1;
        self.editors.lock().await.remove(tab);
    }

    pub async fn schema(&self) -> AppResult<SchemaTree> {
        self.primary_keys.lock().await.clear();
        self.meta(|db| {
            // main and attached files; temp holds only this connection's own objects
            let names: Vec<String> = db
                .prepare("SELECT name FROM pragma_database_list WHERE name <> 'temp' ORDER BY seq")?
                .query_map([], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
            let mut schemas = Vec::new();
            for schema in names {
                let list = format!(
                    "SELECT name, type FROM {}.sqlite_schema
                     WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
                    Dialect::Sqlite.quote_ident(&schema)
                );
                let rels: Vec<(String, String)> =
                    db.prepare(&list)?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
                let relations = rels
                    .into_iter()
                    .map(|(name, kind)| {
                        // a view over a dropped table can't list its columns: show it without
                        let columns = table_xinfo(db, &schema, &name)
                            .unwrap_or_default()
                            .into_iter()
                            .map(|c| ColumnBrief { name: c.0, data_type: c.1 })
                            .collect();
                        let kind = if kind == "view" { RelationKind::View } else { RelationKind::Table };
                        RelationNode { name, kind, estimated_rows: -1, columns }
                    })
                    .collect();
                schemas.push(SchemaNode { name: schema, relations });
            }
            Ok(SchemaTree { schemas })
        })
        .await
    }

    pub async fn structure(&self, schema: &str, table: &str) -> AppResult<TableStructure> {
        // a structure reload (the table tab's refresh) also refreshes the cached key
        self.forget_primary_key(schema, table).await;
        let (schema, table) = (schema.to_string(), table.to_string());
        self.meta(move |db| structure_of(db, &schema, &table)).await
    }

    /// Primary key columns in key order. A rowid table without one pages by rowid; views
    /// and virtual tables get none.
    pub async fn primary_key(&self, schema: &str, table: &str) -> AppResult<Vec<String>> {
        let key = (schema.to_string(), table.to_string());
        if let Some(pk) = self.primary_keys.lock().await.get(&key) {
            return Ok(pk.clone());
        }
        let (s, t) = key.clone();
        let pk = self
            .meta(move |db| {
                let Some((kind, _)) = relation_kind(db, &s, &t)? else { return Ok(vec![]) };
                if kind != "table" {
                    return Ok(vec![]);
                }
                let columns = table_xinfo(db, &s, &t)?;
                let pk = pk_columns(&columns);
                if !pk.is_empty() {
                    return Ok(pk);
                }
                // WITHOUT ROWID needs a primary key, so this table has a rowid, under the
                // first of its names that no column took
                let taken = |alias: &str| columns.iter().any(|c| c.0.eq_ignore_ascii_case(alias));
                Ok(["rowid", "_rowid_", "oid"].into_iter().find(|a| !taken(a)).map(String::from).into_iter().collect())
            })
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
    fn expands_home() {
        let home = Path::new("/home/otter");
        assert_eq!(expand_home("~/db/app.sqlite", Some(home)), PathBuf::from("/home/otter/db/app.sqlite"));
        assert_eq!(expand_home("~", Some(home)), PathBuf::from("/home/otter"));
        assert_eq!(expand_home("/data/~/x.db", Some(home)), PathBuf::from("/data/~/x.db"));
        assert_eq!(expand_home("~/x.db", None), PathBuf::from("~/x.db"));
    }

    #[test]
    fn finds_generated_expressions() {
        let sql = "CREATE TABLE \"t\" (id INTEGER PRIMARY KEY, price DECIMAL(10, 2) CHECK (CAST(price AS INT) > 0),
                   -- a comment, with (parens
                   \"tax \"\"rate\"\"\" REAL GENERATED ALWAYS AS (price * 0.2 /* ) */) VIRTUAL,
                   total AS ((price + \"tax \"\"rate\"\"\") * 1) STORED, UNIQUE (id, total))";
        assert_eq!(generated_expr(sql, "tax \"rate\"").as_deref(), Some("price * 0.2 /* ) */"));
        assert_eq!(generated_expr(sql, "TOTAL").as_deref(), Some("(price + \"tax \"\"rate\"\"\") * 1"));
        assert_eq!(generated_expr(sql, "price"), None);
        assert_eq!(generated_expr(sql, "missing"), None);
    }

    #[test]
    fn identifiers_and_sizes() {
        assert_eq!(ident("customer_id"), "customer_id");
        assert_eq!(ident("select"), "\"select\"");
        assert_eq!(ident("Col A"), "\"Col A\"");
        assert_eq!(pretty_size(8192), "8192 bytes");
        assert_eq!(pretty_size(10240), "10 kB");
        assert_eq!(pretty_size(3 * 1024 * 1024), "3072 kB");
        assert_eq!(pretty_size(30 * 1024 * 1024), "30 MB");
    }

    #[test]
    fn reals_print_like_sqlite() {
        assert_eq!(real(1.0), "1.0");
        assert_eq!(real(0.1), "0.1");
        assert_eq!(real(49.47), "49.47");
        assert_eq!(real(1e20), "1.0e+20");
    }
}
