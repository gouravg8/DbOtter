//! Building the SQL for table browsing, per database dialect. Identifiers and values from the
//! UI are always quoted here, never interpolated raw (except the user's own WHERE clause).

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::model::{Filter, TableQuery};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Postgres,
    Mysql,
    Sqlite,
}

impl Dialect {
    /// `my "table"` -> `"my ""table"""` (MySQL: backticks).
    pub fn quote_ident(self, name: &str) -> String {
        match self {
            Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
            _ => format!("\"{}\"", name.replace('"', "\"\"")),
        }
    }

    /// A string literal that can't be broken out of.
    pub fn quote_literal(self, value: &str) -> String {
        match self {
            // escape-string form: safe whatever standard_conforming_strings is
            Dialect::Postgres => format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''")),
            // quotes are doubled, so this stays closed with or without NO_BACKSLASH_ESCAPES
            Dialect::Mysql => format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''")),
            // no backslash escapes in SQLite
            Dialect::Sqlite => format!("'{}'", value.replace('\'', "''")),
        }
    }

    pub fn qualified(self, schema: &str, table: &str) -> String {
        format!("{}.{}", self.quote_ident(schema), self.quote_ident(table))
    }

    fn as_text(self, expr: &str) -> String {
        match self {
            Dialect::Postgres => format!("{expr}::text"),
            Dialect::Mysql => format!("CAST({expr} AS CHAR)"),
            Dialect::Sqlite => format!("CAST({expr} AS TEXT)"),
        }
    }

    /// Case-insensitive match of `pattern` (`%` / `_` wildcards already placed), with the
    /// value's own wildcards escaped.
    fn like(self, expr: &str, negate: bool, prefix: &str, value: &str, suffix: &str) -> String {
        let not = if negate { "NOT " } else { "" };
        match self {
            // backslash is Postgres' default LIKE escape
            Dialect::Postgres => {
                let v = value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
                format!("{expr} {not}ILIKE {}", self.quote_literal(&format!("{prefix}{v}{suffix}")))
            }
            // SQLite has no default escape; MySQL's depends on the SQL mode: name one
            _ => {
                let v = value.replace('!', "!!").replace('%', "!%").replace('_', "!_");
                format!("{expr} {not}LIKE {} ESCAPE '!'", self.quote_literal(&format!("{prefix}{v}{suffix}")))
            }
        }
    }
}

fn filter_sql(d: Dialect, f: &Filter) -> AppResult<String> {
    let text = d.as_text(&d.quote_ident(&f.column));
    // types without = (json, xml, geometric…) compare as text
    let col = if f.as_text { text.clone() } else { d.quote_ident(&f.column) };
    Ok(match f.op.as_str() {
        "=" | "!=" | "<" | ">" | "<=" | ">=" => {
            let op = if f.op == "!=" { "<>" } else { f.op.as_str() };
            format!("{col} {op} {}", d.quote_literal(&f.value))
        }
        "contains" => d.like(&text, false, "%", &f.value, "%"),
        "not contains" => d.like(&text, true, "%", &f.value, "%"),
        "starts with" => d.like(&text, false, "", &f.value, "%"),
        "is null" => format!("{col} IS NULL"),
        "is not null" => format!("{col} IS NOT NULL"),
        other => return Err(AppError::new(format!("Unknown filter operator: {other}"))),
    })
}

fn where_clause(d: Dialect, q: &TableQuery) -> AppResult<String> {
    let mut parts = q.filters.iter().map(|f| filter_sql(d, f)).collect::<AppResult<Vec<_>>>()?;
    if let Some(raw) = q.where_raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // a trailing -- comment would swallow the closing parenthesis
        parts.push(if raw.contains("--") { format!("({raw}\n)") } else { format!("({raw})") });
    }
    Ok(if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) })
}

/// Every row matching the filters, in the chosen sort or else `default_order` (the primary
/// key, which keeps pages stable).
pub fn table_export(d: Dialect, q: &TableQuery, default_order: &[String]) -> AppResult<String> {
    let mut sql = format!("SELECT * FROM {}{}", d.qualified(&q.schema, &q.table), where_clause(d, q)?);
    if let Some(sort) = &q.sort {
        sql.push_str(&format!(" ORDER BY {} {}", d.quote_ident(&sort.column), if sort.desc { "DESC" } else { "ASC" }));
    } else if !default_order.is_empty() {
        let cols: Vec<String> = default_order.iter().map(|c| d.quote_ident(c)).collect();
        sql.push_str(&format!(" ORDER BY {}", cols.join(", ")));
    }
    Ok(sql)
}

/// One page of [`table_export`].
pub fn table_select(d: Dialect, q: &TableQuery, default_order: &[String]) -> AppResult<String> {
    let mut sql = table_export(d, q, default_order)?;
    sql.push_str(&format!(" LIMIT {}", q.limit.clamp(1, 100_000)));
    if q.offset > 0 {
        sql.push_str(&format!(" OFFSET {}", q.offset));
    }
    Ok(sql)
}

pub fn table_count(d: Dialect, q: &TableQuery) -> AppResult<String> {
    Ok(format!("SELECT count(*) FROM {}{}", d.qualified(&q.schema, &q.table), where_clause(d, q)?))
}

#[derive(Debug, PartialEq)]
enum Token {
    /// Lower-cased.
    Word(String),
    Open,
    /// Byte offset of the `;`.
    Semicolon(usize),
    Other,
}

/// The code of `sql`: words, `(` and `;`, skipping strings, quoted names and comments the way
/// `d` reads them.
fn code_tokens(d: Dialect, sql: &str) -> Vec<Token> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut i = 0;
    // past the closing quote `q`; `backslash`: \ escapes the next byte
    let skip_quoted = |mut i: usize, q: u8, backslash: bool| {
        i += 1;
        while i < n {
            // an escaped byte, or a doubled quote
            if (backslash && b[i] == b'\\') || (b[i] == q && b.get(i + 1) == Some(&q)) {
                i += 2;
            } else if b[i] == q {
                return i + 1;
            } else {
                i += 1;
            }
        }
        n
    };
    let word_byte = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80;
    while i < n {
        let c = b[i];
        let prev_word = i > 0 && word_byte(b[i - 1]);
        if c == b'-' && b.get(i + 1) == Some(&b'-') || c == b'#' && d == Dialect::Mysql {
            i = sql[i..].find('\n').map_or(n, |p| i + p + 1);
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            // Postgres nests block comments
            let mut depth = 0;
            while i < n {
                if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
                    depth += 1;
                    i += 2;
                } else if b[i] == b'*' && b.get(i + 1) == Some(&b'/') {
                    i += 2;
                    depth -= 1;
                    if depth == 0 || d != Dialect::Postgres {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else if c == b'\'' {
            // E'…' is Postgres' backslash-escaped string; MySQL always escapes
            let e_string = d == Dialect::Postgres
                && i > 0
                && matches!(b[i - 1], b'e' | b'E')
                && (i < 2 || !word_byte(b[i - 2]));
            if e_string {
                out.pop();
            }
            i = skip_quoted(i, c, d == Dialect::Mysql || e_string);
        } else if c == b'"' || c == b'`' {
            i = skip_quoted(i, c, d == Dialect::Mysql && c == b'"');
        } else if c == b'[' && d == Dialect::Sqlite {
            i = sql[i..].find(']').map_or(n, |p| i + p + 1);
        } else if c == b'$' && d == Dialect::Postgres && !prev_word {
            // $tag$ … $tag$ (a `$1` parameter isn't one)
            let tag_end = sql[i + 1..].find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_')).map(|p| i + 1 + p);
            match tag_end {
                Some(e) if b[e] == b'$' && !b.get(i + 1).is_some_and(u8::is_ascii_digit) => {
                    let tag = &sql[i..=e];
                    i = sql[e + 1..].find(tag).map_or(n, |p| e + 1 + p + tag.len());
                }
                _ => {
                    out.push(Token::Other);
                    i += 1;
                }
            }
        } else if c.is_ascii_alphabetic() || c == b'_' || c >= 0x80 {
            let start = i;
            while i < n && word_byte(b[i]) {
                i += 1;
            }
            out.push(Token::Word(sql[start..i].to_lowercase()));
        } else if c.is_ascii_digit() {
            while i < n && (b[i].is_ascii_alphanumeric() || b[i] == b'.') {
                i += 1;
            }
        } else {
            out.push(match c {
                b'(' => Token::Open,
                b';' => Token::Semicolon(i),
                _ if c.is_ascii_whitespace() => {
                    i += 1;
                    continue;
                }
                _ => Token::Other,
            });
            i += 1;
        }
    }
    out
}

/// Statements an export may run: it runs the query again, so it has to only read.
const READ_STARTS: &[&str] = &["select", "with", "values", "table", "show", "explain", "describe", "desc"];
/// Words that write anywhere in a statement (a DELETE inside a WITH, EXPLAIN ANALYZE UPDATE,
/// SELECT … INTO). Used as function names (MySQL's INSERT()) they don't count.
const WRITE_WORDS: &[&str] =
    &["insert", "update", "delete", "merge", "upsert", "truncate", "drop", "alter", "create", "grant", "revoke", "into"];

/// The one statement of `sql`, for an export. Refuses several statements and anything that
/// may write. A guard against re-running a write by accident, not a security boundary: the
/// user can run whatever they like in a query tab anyway.
pub fn read_query(d: Dialect, sql: &str) -> AppResult<&str> {
    let tokens = code_tokens(d, sql);
    let end = tokens.iter().position(|t| matches!(t, Token::Semicolon(_))).unwrap_or(tokens.len());
    if tokens[end..].iter().any(|t| !matches!(t, Token::Semicolon(_))) {
        return Err(AppError::new("Export runs one statement: select just the query to export"));
    }
    let code = &tokens[..end];
    let refuse = |what: String| {
        Err(AppError::new(format!("Only queries that read can be exported ({what}): exporting runs the query again"))
            .with_code("not_read_only"))
    };
    match code.iter().find_map(|t| if let Token::Word(w) = t { Some(w.as_str()) } else { None }) {
        None => return Err(AppError::new("Nothing to export: the query is empty")),
        Some(first) if !READ_STARTS.contains(&first) => return refuse(first.to_uppercase()),
        _ => {}
    }
    for (k, t) in code.iter().enumerate() {
        let Token::Word(w) = t else { continue };
        let call = matches!(code.get(k + 1), Some(Token::Open)) && w != "into";
        let prev = match k.checked_sub(1).map(|j| &code[j]) {
            Some(Token::Word(p)) => p.as_str(),
            _ => "",
        };
        // FOR UPDATE / FOR NO KEY UPDATE lock rows, they don't write
        let lock = w == "update" && matches!(prev, "for" | "key");
        if WRITE_WORDS.contains(&w.as_str()) && !call && !lock {
            return refuse(w.to_uppercase());
        }
    }
    Ok(match tokens.get(end) {
        Some(Token::Semicolon(at)) => sql[..*at].trim(),
        _ => sql.trim(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Sort;
    use Dialect::*;

    fn query() -> TableQuery {
        TableQuery {
            schema: "public".into(),
            table: "users".into(),
            limit: 100,
            offset: 0,
            sort: None,
            filters: vec![],
            where_raw: None,
        }
    }

    fn filter(column: &str, op: &str, value: &str) -> Filter {
        Filter { column: column.into(), op: op.into(), value: value.into(), as_text: false }
    }

    #[test]
    fn export_queries_must_read_and_be_one_statement() {
        assert_eq!(read_query(Postgres, "  select * from t;  -- done\n").unwrap(), "select * from t");
        assert_eq!(read_query(Mysql, "SHOW TABLES").unwrap(), "SHOW TABLES");
        for ok in [
            "with x as (select 1) select * from x",
            "(select 1) union (select 2)",
            "select * from t for update",
            "select * from t for no key update",
            "select 'delete from t', \"update\" from t /* drop table t */",
            "select $$ insert into t $$, $q$ ; drop $q$",
            "select e'it\\'s; delete' from t",
        ] {
            assert!(read_query(Postgres, ok).is_ok(), "{ok}");
        }
        // MySQL string functions named like writes; backslash escapes; # comments
        assert!(read_query(Mysql, "select insert('abc', 1, 1, 'x'), replace(a, 'b', 'c') from t").is_ok());
        assert!(read_query(Mysql, "select 'it\\'s; drop table t' # ; delete").is_ok());
        assert!(read_query(Sqlite, "select [delete] from t").is_ok());

        for bad in [
            "delete from t",
            "update t set a = 1",
            "with d as (delete from t returning *) select * from d",
            "explain analyze delete from t",
            "select * into t2 from t",
            "insert into t select 1",
            "call p()",
            "",
        ] {
            assert!(read_query(Postgres, bad).is_err(), "{bad}");
        }
        assert!(read_query(Mysql, "select * from t into outfile '/tmp/x'").is_err());
        let two = read_query(Postgres, "select 1; select 2").unwrap_err();
        assert!(two.message.contains("one statement"), "{}", two.message);
        assert_eq!(read_query(Postgres, "drop table t").unwrap_err().code.as_deref(), Some("not_read_only"));
    }

    #[test]
    fn exports_every_row_in_order() {
        let mut q = query();
        q.offset = 200;
        assert_eq!(table_export(Postgres, &q, &["id".into()]).unwrap(), "SELECT * FROM \"public\".\"users\" ORDER BY \"id\"");
    }

    #[test]
    fn quotes_identifiers() {
        assert_eq!(Postgres.quote_ident("users"), "\"users\"");
        assert_eq!(Postgres.quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(Sqlite.quote_ident("we\"ird"), "\"we\"\"ird\"");
        assert_eq!(Mysql.quote_ident("we`ird"), "`we``ird`");
    }

    #[test]
    fn quotes_literals() {
        assert_eq!(Postgres.quote_literal("it's"), "E'it''s'");
        assert_eq!(Postgres.quote_literal("a\\b"), "E'a\\\\b'");
        // an attempt to break out stays inside the literal
        assert_eq!(Postgres.quote_literal("x'; DROP TABLE t; --"), "E'x''; DROP TABLE t; --'");
        assert_eq!(Mysql.quote_literal("x\\'; DROP TABLE t; --"), "'x\\\\''; DROP TABLE t; --'");
        assert_eq!(Sqlite.quote_literal("a\\b'c"), "'a\\b''c'");
    }

    #[test]
    fn builds_select() {
        let mut q = query();
        assert_eq!(table_select(Postgres, &q, &[]).unwrap(), "SELECT * FROM \"public\".\"users\" LIMIT 100");
        assert_eq!(
            table_select(Postgres, &q, &["tenant".into(), "id".into()]).unwrap(),
            "SELECT * FROM \"public\".\"users\" ORDER BY \"tenant\", \"id\" LIMIT 100"
        );
        q.offset = 200;
        q.sort = Some(Sort { column: "created at".into(), desc: true });
        q.filters = vec![filter("name", "contains", "50%_off"), filter("age", ">=", "18"), filter("deleted_at", "is null", "")];
        q.where_raw = Some(" id < 10 ".into());
        assert_eq!(
            table_select(Postgres, &q, &["id".into()]).unwrap(),
            "SELECT * FROM \"public\".\"users\" WHERE \"name\"::text ILIKE E'%50\\\\%\\\\_off%' AND \"age\" >= E'18' \
             AND \"deleted_at\" IS NULL AND (id < 10) ORDER BY \"created at\" DESC LIMIT 100 OFFSET 200"
        );
        assert_eq!(
            table_count(Postgres, &q).unwrap(),
            "SELECT count(*) FROM \"public\".\"users\" WHERE \"name\"::text ILIKE E'%50\\\\%\\\\_off%' AND \"age\" >= E'18' \
             AND \"deleted_at\" IS NULL AND (id < 10)"
        );
    }

    #[test]
    fn mysql_and_sqlite_dialects() {
        let mut q = query();
        q.schema = "shop".into();
        q.filters = vec![filter("name", "starts with", "50%_off!"), filter("age", ">=", "18")];
        assert_eq!(
            table_select(Mysql, &q, &["id".into()]).unwrap(),
            "SELECT * FROM `shop`.`users` WHERE CAST(`name` AS CHAR) LIKE '50!%!_off!!%' ESCAPE '!' AND `age` >= '18' \
             ORDER BY `id` LIMIT 100"
        );
        q.schema = "main".into();
        q.filters = vec![filter("name", "not contains", "it's")];
        assert_eq!(
            table_count(Sqlite, &q).unwrap(),
            "SELECT count(*) FROM \"main\".\"users\" WHERE CAST(\"name\" AS TEXT) NOT LIKE '%it''s%' ESCAPE '!'"
        );
    }

    #[test]
    fn rejects_unknown_operator() {
        let mut q = query();
        q.filters = vec![filter("a", "; drop", "")];
        assert!(table_select(Postgres, &q, &[]).is_err());
    }

    #[test]
    fn text_comparison_for_types_without_equality() {
        let mut q = query();
        q.filters = vec![Filter { column: "meta".into(), op: "=".into(), value: "{}".into(), as_text: true }];
        assert_eq!(table_count(Postgres, &q).unwrap(), "SELECT count(*) FROM \"public\".\"users\" WHERE \"meta\"::text = E'{}'");
    }
}
