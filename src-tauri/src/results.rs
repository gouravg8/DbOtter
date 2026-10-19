//! Collecting query results, the same way for every engine: rows as text, NULL as `None`,
//! capped by row count and memory. Past the cap rows are read and dropped rather than
//! stored, so the statement, and any after it, still run to completion (stopping early would
//! abort a transaction and skip later statements).

use crate::error::AppError;
use crate::model::{QueryOutput, ResultSet};

/// Result memory cap per run, on top of the row limit (wide rows, huge values).
pub const MAX_RESULT_BYTES: usize = 64 * 1024 * 1024;
/// Cancelled by the user. Postgres' SQLSTATE, used for every engine so the UI sees one code.
pub const CANCELED: &str = "57014";

pub fn canceled() -> AppError {
    AppError::new("canceling statement due to user request").with_code(CANCELED)
}

pub struct Collector {
    max_rows: usize,
    bytes: usize,
    results: Vec<ResultSet>,
    current: Option<ResultSet>,
}

impl Collector {
    pub fn new(max_rows: usize) -> Self {
        Self { max_rows: max_rows.max(1), bytes: 0, results: Vec::new(), current: None }
    }

    /// A statement that returns rows starts.
    pub fn columns(&mut self, columns: Vec<String>) {
        self.current = Some(ResultSet { columns, has_rows: true, ..Default::default() });
    }

    /// Whether the next row would be kept; check before converting a row to text.
    pub fn wants_row(&self) -> bool {
        self.current.as_ref().is_none_or(|c| !c.truncated)
    }

    pub fn row(&mut self, cells: Vec<Option<String>>) {
        let set = self.current.get_or_insert_with(|| ResultSet { has_rows: true, ..Default::default() });
        if set.truncated {
            return;
        }
        let size: usize = cells.iter().map(|c| c.as_ref().map_or(0, String::len) + 16).sum();
        if set.rows.len() >= self.max_rows || self.bytes + size > MAX_RESULT_BYTES {
            set.truncated = true;
            return;
        }
        self.bytes += size;
        set.rows.push(cells);
    }

    /// The statement finished: `row_count` rows returned or affected (for a truncated result
    /// the full count, more than the rows kept).
    pub fn complete(&mut self, row_count: u64) {
        let mut set = self.current.take().unwrap_or_default();
        set.row_count = row_count;
        self.results.push(set);
    }

    /// A statement that returned rows finished without a count from the server.
    pub fn complete_counted(&mut self) {
        let n = self.current.as_ref().map_or(0, |c| c.rows.len() as u64);
        self.complete(n);
    }

    /// Ends the run. On error, a result cut off past the limit is kept: if the user cancelled
    /// while the extra rows were being skipped, those rows are still shown.
    pub fn finish(
        mut self,
        outcome: Result<(), AppError>,
        user_cancelled: bool,
        duration_ms: u64,
    ) -> Result<QueryOutput, AppError> {
        match outcome {
            Ok(()) => {
                if self.current.is_some() {
                    self.complete_counted();
                }
                Ok(QueryOutput { results: self.results, duration_ms, canceled: false })
            }
            Err(e) => {
                if let Some(mut set) = self.current.take().filter(|c| c.truncated) {
                    set.row_count = set.rows.len() as u64;
                    self.results.push(set);
                }
                // only when every result is rows: a batch is one implicit transaction, so
                // earlier writes in it were rolled back and must not look done
                let keep = e.code.as_deref() == Some(CANCELED)
                    && user_cancelled
                    && self.results.last().is_some_and(|r| r.truncated)
                    && self.results.iter().all(|r| r.has_rows);
                if keep { Ok(QueryOutput { results: self.results, duration_ms, canceled: true }) } else { Err(e) }
            }
        }
    }
}

/// `\x` hex for binary values, as Postgres shows bytea.
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("\\x");
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(v: &str) -> Vec<Option<String>> {
        vec![Some(v.into()), None]
    }

    #[test]
    fn caps_rows_and_keeps_full_count() {
        let mut c = Collector::new(2);
        c.columns(vec!["a".into(), "b".into()]);
        for i in 0..5 {
            c.row(row(&i.to_string()));
        }
        assert!(!c.wants_row());
        c.complete(5);
        c.complete(3); // a later UPDATE
        let out = c.finish(Ok(()), false, 1).unwrap();
        assert_eq!(out.results[0].rows.len(), 2);
        assert!(out.results[0].truncated);
        assert_eq!(out.results[0].row_count, 5);
        assert!(!out.results[1].has_rows);
        assert_eq!(out.results[1].row_count, 3);
    }

    #[test]
    fn user_cancel_past_the_limit_keeps_rows_unless_a_write_came_first() {
        let mut c = Collector::new(1);
        c.columns(vec!["a".into()]);
        c.row(row("1"));
        c.row(row("2"));
        let out = c.finish(Err(canceled()), true, 1).unwrap();
        assert!(out.canceled);
        assert_eq!(out.results[0].rows.len(), 1);

        let mut c = Collector::new(1);
        c.complete(1); // INSERT
        c.columns(vec!["a".into()]);
        c.row(row("1"));
        c.row(row("2"));
        assert!(c.finish(Err(canceled()), true, 1).is_err());

        // statement_timeout (not the user) is an error
        let mut c = Collector::new(1);
        c.columns(vec!["a".into()]);
        c.row(row("1"));
        c.row(row("2"));
        assert!(c.finish(Err(canceled()), false, 1).is_err());
    }

    #[test]
    fn hex_like_bytea() {
        assert_eq!(hex(&[0xde, 0xad, 0x01]), "\\xdead01");
    }
}
