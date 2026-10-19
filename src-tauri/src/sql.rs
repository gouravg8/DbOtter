//! Building the SQL for table browsing. Identifiers and values from the UI are always
//! quoted here, never interpolated raw (except the user's own WHERE clause).

use crate::error::{AppError, AppResult};
use crate::model::{Filter, TableQuery};

/// `my "table"` -> `"my ""table"""`
pub fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Escape-string literal, safe whatever `standard_conforming_strings` is set to.
pub fn quote_literal(value: &str) -> String {
    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

/// Escapes LIKE wildcards so the value matches literally (backslash is LIKE's default escape).
fn like_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub fn qualified(schema: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(schema), quote_ident(table))
}

fn filter_sql(f: &Filter) -> AppResult<String> {
    let text = format!("{}::text", quote_ident(&f.column));
    // types without = (json, xml, geometric…) compare as text
    let col = if f.as_text { text.clone() } else { quote_ident(&f.column) };
    Ok(match f.op.as_str() {
        "=" | "!=" | "<" | ">" | "<=" | ">=" => {
            let op = if f.op == "!=" { "<>" } else { f.op.as_str() };
            format!("{col} {op} {}", quote_literal(&f.value))
        }
        "contains" => format!("{text} ILIKE {}", quote_literal(&format!("%{}%", like_escape(&f.value)))),
        "not contains" => format!("{text} NOT ILIKE {}", quote_literal(&format!("%{}%", like_escape(&f.value)))),
        "starts with" => format!("{text} ILIKE {}", quote_literal(&format!("{}%", like_escape(&f.value)))),
        "is null" => format!("{col} IS NULL"),
        "is not null" => format!("{col} IS NOT NULL"),
        other => return Err(AppError::new(format!("Unknown filter operator: {other}"))),
    })
}

fn where_clause(q: &TableQuery) -> AppResult<String> {
    let mut parts = q.filters.iter().map(filter_sql).collect::<AppResult<Vec<_>>>()?;
    if let Some(raw) = q.where_raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // a trailing -- comment would swallow the closing parenthesis
        parts.push(if raw.contains("--") { format!("({raw}\n)") } else { format!("({raw})") });
    }
    Ok(if parts.is_empty() { String::new() } else { format!(" WHERE {}", parts.join(" AND ")) })
}

/// `default_order` (the primary key) keeps pages stable when no sort is chosen.
pub fn table_select(q: &TableQuery, default_order: &[String]) -> AppResult<String> {
    let mut sql = format!("SELECT * FROM {}{}", qualified(&q.schema, &q.table), where_clause(q)?);
    if let Some(sort) = &q.sort {
        sql.push_str(&format!(" ORDER BY {} {}", quote_ident(&sort.column), if sort.desc { "DESC" } else { "ASC" }));
    } else if !default_order.is_empty() {
        let cols: Vec<String> = default_order.iter().map(|c| quote_ident(c)).collect();
        sql.push_str(&format!(" ORDER BY {}", cols.join(", ")));
    }
    sql.push_str(&format!(" LIMIT {}", q.limit.clamp(1, 100_000)));
    if q.offset > 0 {
        sql.push_str(&format!(" OFFSET {}", q.offset));
    }
    Ok(sql)
}

pub fn table_count(q: &TableQuery) -> AppResult<String> {
    Ok(format!("SELECT count(*) FROM {}{}", qualified(&q.schema, &q.table), where_clause(q)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Sort;

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

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_ident("users"), "\"users\"");
        assert_eq!(quote_ident("we\"ird"), "\"we\"\"ird\"");
    }

    #[test]
    fn quotes_literals() {
        assert_eq!(quote_literal("it's"), "E'it''s'");
        assert_eq!(quote_literal("a\\b"), "E'a\\\\b'");
        // an attempt to break out stays inside the literal
        assert_eq!(quote_literal("x'; DROP TABLE t; --"), "E'x''; DROP TABLE t; --'");
    }

    #[test]
    fn builds_select() {
        let mut q = query();
        assert_eq!(table_select(&q, &[]).unwrap(), "SELECT * FROM \"public\".\"users\" LIMIT 100");
        assert_eq!(
            table_select(&q, &["tenant".into(), "id".into()]).unwrap(),
            "SELECT * FROM \"public\".\"users\" ORDER BY \"tenant\", \"id\" LIMIT 100"
        );
        q.offset = 200;
        q.sort = Some(Sort { column: "created at".into(), desc: true });
        q.filters = vec![
            Filter { column: "name".into(), op: "contains".into(), value: "50%_off".into(), as_text: false },
            Filter { column: "age".into(), op: ">=".into(), value: "18".into(), as_text: false },
            Filter { column: "deleted_at".into(), op: "is null".into(), value: String::new(), as_text: false },
        ];
        q.where_raw = Some(" id < 10 ".into());
        assert_eq!(
            table_select(&q, &["id".into()]).unwrap(),
            "SELECT * FROM \"public\".\"users\" WHERE \"name\"::text ILIKE E'%50\\\\%\\\\_off%' AND \"age\" >= E'18' \
             AND \"deleted_at\" IS NULL AND (id < 10) ORDER BY \"created at\" DESC LIMIT 100 OFFSET 200"
        );
        assert_eq!(
            table_count(&q).unwrap(),
            "SELECT count(*) FROM \"public\".\"users\" WHERE \"name\"::text ILIKE E'%50\\\\%\\\\_off%' AND \"age\" >= E'18' \
             AND \"deleted_at\" IS NULL AND (id < 10)"
        );
    }

    #[test]
    fn rejects_unknown_operator() {
        let mut q = query();
        q.filters = vec![Filter { column: "a".into(), op: "; drop".into(), value: String::new(), as_text: false }];
        assert!(table_select(&q, &[]).is_err());
    }

    #[test]
    fn text_comparison_for_types_without_equality() {
        let mut q = query();
        q.filters = vec![Filter { column: "meta".into(), op: "=".into(), value: "{}".into(), as_text: true }];
        assert_eq!(table_count(&q).unwrap(), "SELECT count(*) FROM \"public\".\"users\" WHERE \"meta\"::text = E'{}'");
    }
}
