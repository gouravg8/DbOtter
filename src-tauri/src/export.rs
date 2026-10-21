//! Writing a run's rows to a file as they arrive (CSV, JSON or SQL INSERTs), so exporting a
//! table doesn't hold it in memory. The file is written next to its final name and moved
//! there only once every row is in: a failed or cancelled export leaves nothing behind, and
//! doesn't damage a file it was replacing.

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::results::{Literal, Sink};
use crate::sql::Dialect;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
}

/// Rows per INSERT in a SQL export: fast to load, short enough for any server's packet limit.
const INSERT_BATCH: usize = 100;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
    pub duration_ms: u64,
}

pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).filter(|h| !h.is_empty()).map(PathBuf::from)
}

/// Where exports go unless the user picks another folder: Downloads, else home.
pub fn default_dir() -> PathBuf {
    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
    let downloads = home.join("Downloads");
    if downloads.is_dir() { downloads } else { home }
}

/// `~/x.csv` -> `/home/me/x.csv`. Relative paths are refused: they'd land wherever the app
/// was started from.
pub fn resolve_path(path: &str) -> AppResult<PathBuf> {
    let path = path.trim();
    let resolved = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') => {
            let home = home_dir().ok_or_else(|| AppError::new("No home folder to put the file in"))?;
            home.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(path),
    };
    if !resolved.is_absolute() {
        return Err(AppError::new("Choose a full path for the file (like ~/Downloads/orders.csv)"));
    }
    if resolved.file_name().is_none() || path.ends_with(['/', '\\']) {
        return Err(AppError::new("The path needs a file name"));
    }
    Ok(resolved)
}

pub struct ExportSink {
    format: ExportFormat,
    dialect: Dialect,
    /// Quoted table name for INSERTs.
    target: String,
    path: PathBuf,
    part: PathBuf,
    out: Option<BufWriter<File>>,
    columns: Option<Vec<String>>,
    rows: u64,
    bytes: u64,
    /// The first write error; rows after it are skipped.
    error: Option<AppError>,
    /// Rows in the INSERT being written (SQL format).
    in_batch: usize,
    done: bool,
}

impl ExportSink {
    /// Opens the file. Fails here, before the query runs, for a bad folder or a file that
    /// exists when `overwrite` is off (code `exists`).
    pub fn create(path: PathBuf, format: ExportFormat, dialect: Dialect, target: &str, overwrite: bool) -> AppResult<Self> {
        if path.is_dir() {
            return Err(AppError::new(format!("{} is a folder", path.display())));
        }
        if !overwrite && path.exists() {
            return Err(AppError::new(format!("{} already exists", path.display())).with_code("exists"));
        }
        let mut part = path.clone().into_os_string();
        part.push(".part");
        let part = PathBuf::from(part);
        let file = File::create(&part).map_err(|e| AppError::new(format!("Can't write {}: {e}", path.display())))?;
        Ok(Self {
            format,
            dialect,
            target: dialect.quote_ident(target),
            path,
            part,
            out: Some(BufWriter::with_capacity(256 * 1024, file)),
            columns: None,
            rows: 0,
            bytes: 0,
            error: None,
            in_batch: 0,
            done: false,
        })
    }

    fn put(&mut self, s: &str) {
        if self.error.is_some() {
            return;
        }
        if let Some(out) = self.out.as_mut() {
            match out.write_all(s.as_bytes()) {
                Ok(()) => self.bytes += s.len() as u64,
                Err(e) => self.error = Some(AppError::new(format!("Writing {} failed: {e}", self.path.display()))),
            }
        }
    }

    /// Ends the export: on success the file is moved to its name, otherwise removed.
    pub fn finish(mut self, outcome: AppResult<()>, duration_ms: u64) -> AppResult<ExportResult> {
        outcome?;
        if self.columns.is_none() {
            return Err(AppError::new("The query returned no rows to export"));
        }
        match self.format {
            ExportFormat::Csv => {}
            ExportFormat::Json => self.put(if self.rows == 0 { "]\n" } else { "\n]\n" }),
            ExportFormat::Sql => {
                if self.in_batch > 0 {
                    self.put(";\n");
                }
            }
        }
        if let Some(e) = self.error.take() {
            return Err(e);
        }
        let out = self.out.take().expect("export file open until finished");
        let written = out.into_inner().map_err(|e| e.into_error()).and_then(|f| f.sync_all());
        written
            .and_then(|()| std::fs::rename(&self.part, &self.path))
            .map_err(|e| AppError::new(format!("Writing {} failed: {e}", self.path.display())))?;
        self.done = true;
        Ok(ExportResult { path: self.path.display().to_string(), rows: self.rows, bytes: self.bytes, duration_ms })
    }

    fn literal(&self, v: &str, form: Literal) -> String {
        let hex = v.strip_prefix("\\x").filter(|h| h.len() % 2 == 0 && h.bytes().all(|b| b.is_ascii_hexdigit()));
        match form {
            // Inf / NaN aren't SQL numbers
            Literal::Number if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) => v.to_string(),
            Literal::Hex if let Some(h) = hex => format!("X'{h}'"),
            Literal::Bits if !v.is_empty() && v.bytes().all(|b| b == b'0' || b == b'1') => format!("b'{v}'"),
            _ => self.dialect.quote_literal(v),
        }
    }

    fn csv_row<'a>(&mut self, cells: impl Iterator<Item = Option<&'a str>>) {
        let mut line = String::new();
        for (i, cell) in cells.enumerate() {
            if i > 0 {
                line.push(',');
            }
            // NULL is an empty field, an empty string is "" (how Postgres' COPY tells them apart)
            match cell {
                None => {}
                Some(v) if v.is_empty() || v.contains([',', '"', '\n', '\r']) => {
                    line.push('"');
                    line.push_str(&v.replace('"', "\"\""));
                    line.push('"');
                }
                Some(v) => line.push_str(v),
            }
        }
        line.push('\n');
        self.put(&line);
    }
}

impl Drop for ExportSink {
    fn drop(&mut self) {
        if !self.done {
            drop(self.out.take());
            let _ = std::fs::remove_file(&self.part);
        }
    }
}

/// JSON keys must differ: a second `id` becomes `id_2`.
fn unique_names(columns: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(columns.len());
    for c in columns {
        let mut name = c.clone();
        let mut n = 1;
        while out.contains(&name) {
            n += 1;
            name = format!("{c}_{n}");
        }
        out.push(name);
    }
    out
}

impl Sink for ExportSink {
    fn columns(&mut self, columns: Vec<String>) {
        if self.columns.is_some() {
            // only one statement is run, so this is a procedure returning several results
            self.error.get_or_insert_with(|| AppError::new("The query returned more than one result; export one at a time"));
            return;
        }
        match self.format {
            ExportFormat::Csv => self.csv_row(columns.iter().map(|c| Some(c.as_str()))),
            ExportFormat::Json => self.put("["),
            ExportFormat::Sql => {}
        }
        self.columns = Some(match self.format {
            ExportFormat::Json => unique_names(&columns),
            _ => columns,
        });
    }

    fn wants_row(&self) -> bool {
        self.error.is_none()
    }

    fn row(&mut self, cells: Vec<Option<String>>) {
        self.row_with(cells, &[]);
    }

    fn row_with(&mut self, cells: Vec<Option<String>>, forms: &[Literal]) {
        if self.error.is_some() {
            return;
        }
        let columns = self.columns.take().unwrap_or_default();
        match self.format {
            ExportFormat::Csv => self.csv_row(cells.iter().map(Option::as_deref)),
            ExportFormat::Json => {
                let mut obj = String::from(if self.rows == 0 { "\n  {" } else { ",\n  {" });
                for (i, (name, cell)) in columns.iter().zip(&cells).enumerate() {
                    if i > 0 {
                        obj.push_str(", ");
                    }
                    obj.push_str(&serde_json::Value::from(name.as_str()).to_string());
                    obj.push_str(": ");
                    obj.push_str(&cell.as_deref().map_or_else(|| "null".into(), |v| serde_json::Value::from(v).to_string()));
                }
                obj.push('}');
                self.put(&obj);
            }
            ExportFormat::Sql => {
                let mut sql = String::new();
                if self.in_batch == 0 {
                    let names: Vec<String> = columns.iter().map(|c| self.dialect.quote_ident(c)).collect();
                    sql.push_str(&format!("INSERT INTO {} ({}) VALUES\n  (", self.target, names.join(", ")));
                } else {
                    sql.push_str(",\n  (");
                }
                for (i, cell) in cells.iter().enumerate() {
                    if i > 0 {
                        sql.push_str(", ");
                    }
                    match cell {
                        Some(v) => sql.push_str(&self.literal(v, forms.get(i).copied().unwrap_or(Literal::Text))),
                        None => sql.push_str("NULL"),
                    }
                }
                sql.push(')');
                self.in_batch += 1;
                if self.in_batch == INSERT_BATCH {
                    sql.push_str(";\n");
                    self.in_batch = 0;
                }
                self.put(&sql);
            }
        }
        self.columns = Some(columns);
        self.rows += 1;
    }

    fn complete(&mut self, _row_count: u64) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("dbotter-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn export(format: ExportFormat, dialect: Dialect, columns: &[&str], rows: &[Vec<Option<&str>>]) -> (String, ExportResult) {
        let path = dir().join("out");
        let mut sink = ExportSink::create(path.clone(), format, dialect, "people", false).unwrap();
        sink.columns(columns.iter().map(|c| c.to_string()).collect());
        for r in rows {
            assert!(sink.wants_row());
            sink.row(r.iter().map(|c| c.map(str::to_string)).collect());
        }
        sink.complete(rows.len() as u64);
        let result = sink.finish(Ok(()), 5).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
        (text, result)
    }

    #[test]
    fn csv_quotes_only_what_needs_it_and_tells_null_from_empty() {
        let rows = vec![vec![Some("1"), Some("plain")], vec![Some("2"), Some("a,\"b\"\nc")], vec![Some("3"), None], vec![Some("4"), Some("")]];
        let (text, result) = export(ExportFormat::Csv, Dialect::Postgres, &["id", "note"], &rows);
        assert_eq!(text, "id,note\n1,plain\n2,\"a,\"\"b\"\"\nc\"\n3,\n4,\"\"\n");
        assert_eq!(result.rows, 4);
        assert_eq!(result.bytes, text.len() as u64);
    }

    #[test]
    fn json_is_an_array_of_objects_in_column_order() {
        let (text, _) = export(ExportFormat::Json, Dialect::Postgres, &["z", "a", "a"], &[vec![Some("1"), Some("x\"y"), None]]);
        assert_eq!(text, "[\n  {\"z\": \"1\", \"a\": \"x\\\"y\", \"a_2\": null}\n]\n");
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value[0]["a_2"], serde_json::Value::Null);
        let (empty, _) = export(ExportFormat::Json, Dialect::Postgres, &["a"], &[]);
        assert_eq!(empty, "[]\n");
    }

    #[test]
    fn sql_batches_inserts_with_the_dialects_quoting() {
        let (text, _) = export(ExportFormat::Sql, Dialect::Mysql, &["id", "name"], &[vec![Some("1"), Some("it's")], vec![Some("2"), None]]);
        assert_eq!(text, "INSERT INTO `people` (`id`, `name`) VALUES\n  ('1', 'it''s'),\n  ('2', NULL);\n");
        let rows: Vec<Vec<Option<&str>>> = (0..INSERT_BATCH + 1).map(|_| vec![Some("1")]).collect();
        let (text, _) = export(ExportFormat::Sql, Dialect::Postgres, &["n"], &rows);
        assert_eq!(text.matches("INSERT INTO \"people\" (\"n\") VALUES").count(), 2);
        assert_eq!(text.matches(';').count(), 2);
        assert!(text.ends_with("VALUES\n  (E'1');\n"));
    }

    #[test]
    fn sql_writes_binary_bits_and_numbers_as_their_own_literals() {
        let path = dir().join("out.sql");
        let mut sink = ExportSink::create(path.clone(), ExportFormat::Sql, Dialect::Sqlite, "t", false).unwrap();
        sink.columns(vec!["n".into(), "b".into(), "s".into(), "bits".into(), "inf".into()]);
        let cells = ["1.5", "\\xdead01", "7", "101", "Inf"].map(|v| Some(v.to_string())).to_vec();
        sink.row_with(cells, &[Literal::Number, Literal::Hex, Literal::Text, Literal::Bits, Literal::Number]);
        sink.finish(Ok(()), 1).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with("(1.5, X'dead01', '7', b'101', 'Inf');\n"), "{text}");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_failed_or_dropped_export_leaves_no_file_and_keeps_the_old_one() {
        let d = dir();
        let path = d.join("t.csv");
        std::fs::write(&path, "old").unwrap();
        let err = ExportSink::create(path.clone(), ExportFormat::Csv, Dialect::Sqlite, "t", false).err().unwrap();
        assert_eq!(err.code.as_deref(), Some("exists"));

        let mut sink = ExportSink::create(path.clone(), ExportFormat::Csv, Dialect::Sqlite, "t", true).unwrap();
        sink.columns(vec!["a".into()]);
        sink.row(vec![Some("1".into())]);
        assert!(sink.finish(Err(crate::results::canceled()), 1).is_err());
        drop(ExportSink::create(path.clone(), ExportFormat::Csv, Dialect::Sqlite, "t", true).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "old");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "no .part file left");
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn paths_expand_home_and_must_be_absolute_files() {
        let home = home_dir().unwrap();
        assert_eq!(resolve_path("~/x.csv").unwrap(), home.join("x.csv"));
        assert!(resolve_path("x.csv").is_err());
        assert!(resolve_path("/tmp/").is_err());
        assert_eq!(resolve_path(" /tmp/a.json ").unwrap(), PathBuf::from("/tmp/a.json"));
    }
}
