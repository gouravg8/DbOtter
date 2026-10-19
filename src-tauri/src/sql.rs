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

/// `default_order` (the primary key) keeps pages stable when no sort is chosen.
pub fn table_select(d: Dialect, q: &TableQuery, default_order: &[String]) -> AppResult<String> {
    let mut sql = format!("SELECT * FROM {}{}", d.qualified(&q.schema, &q.table), where_clause(d, q)?);
    if let Some(sort) = &q.sort {
        sql.push_str(&format!(" ORDER BY {} {}", d.quote_ident(&sort.column), if sort.desc { "DESC" } else { "ASC" }));
    } else if !default_order.is_empty() {
        let cols: Vec<String> = default_order.iter().map(|c| d.quote_ident(c)).collect();
        sql.push_str(&format!(" ORDER BY {}", cols.join(", ")));
    }
    sql.push_str(&format!(" LIMIT {}", q.limit.clamp(1, 100_000)));
    if q.offset > 0 {
        sql.push_str(&format!(" OFFSET {}", q.offset));
    }
    Ok(sql)
}

pub fn table_count(d: Dialect, q: &TableQuery) -> AppResult<String> {
    Ok(format!("SELECT count(*) FROM {}{}", d.qualified(&q.schema, &q.table), where_clause(d, q)?))
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
