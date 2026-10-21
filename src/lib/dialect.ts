/** SQL text the UI writes itself (New query, Copy name), in each database's dialect. */
import type { ConnectionConfig, DbKind } from "./api";

/** `my "table"` -> `"my ""table"""`; MySQL uses backticks. */
export function quoteIdent(kind: DbKind, name: string) {
  return kind === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

export function qualified(kind: DbKind, schema: string, table: string) {
  return `${quoteIdent(kind, schema)}.${quoteIdent(kind, table)}`;
}

/** How the error panel labels an error code. */
export function codeLabel(kind: DbKind | undefined) {
  return kind === "postgres" || !kind ? "SQLSTATE" : "Error";
}

/** user@host:port/db, or the file path for SQLite. */
export function describeConnection(c: Pick<ConnectionConfig, "kind" | "user" | "host" | "port" | "database">) {
  return c.kind === "sqlite" ? c.database : `${c.user}@${c.host}:${c.port}/${c.database}`;
}
