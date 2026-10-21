/**
 * Typed calls into the Rust backend. Inside the app they go through Tauri IPC; in a plain
 * browser (`pnpm dev:browser`) they go to the dev bridge (src-tauri/examples/bridge.rs).
 */
import { invoke } from "@tauri-apps/api/core";

export type SslMode = "disable" | "prefer" | "require" | "verify-full";

/** Database engine. For "sqlite", `database` is the file path and host / port / user are unused. */
export type DbKind = "postgres" | "mysql" | "sqlite";

export const KIND_LABEL: Record<DbKind, string> = { postgres: "PostgreSQL", mysql: "MySQL / MariaDB", sqlite: "SQLite" };
export const DEFAULT_PORT: Record<DbKind, number> = { postgres: 5432, mysql: 3306, sqlite: 0 };

export interface ConnectionConfig {
  id: string;
  kind: DbKind;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: SslMode;
  savePassword: boolean;
  color: string | null;
  /** PEM file of CA certificates for verify-full. */
  sslRootCert: string | null;
  /** The database refuses writes on this connection. */
  readOnly: boolean;
  /** Ask before risky statements (UPDATE / DELETE without WHERE, DROP, TRUNCATE). */
  production: boolean;
  createdAt: number;
}

export interface ConnectionInput {
  id?: string;
  kind: DbKind;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: SslMode;
  savePassword: boolean;
  color?: string | null;
  sslRootCert?: string | null;
  readOnly?: boolean;
  production?: boolean;
  /** Omit to keep the saved password. */
  password?: string;
}

export interface AppError {
  message: string;
  code?: string;
  detail?: string;
  hint?: string;
  /** 1-based character offset into the executed SQL. */
  position?: number;
}

export interface SessionInfo {
  kind: DbKind;
  /** "PostgreSQL", "MySQL", "MariaDB" or "SQLite" */
  product: string;
  serverVersion: string;
  database: string;
  user: string;
  /** Where unqualified names resolve: public, the MySQL database, or main. */
  defaultSchema: string;
  readOnly: boolean;
}

export type RelationKind = "table" | "view" | "materializedView" | "foreignTable";

export interface ColumnBrief {
  name: string;
  dataType: string;
}

export interface RelationNode {
  name: string;
  kind: RelationKind;
  estimatedRows: number;
  columns: ColumnBrief[];
}

export interface SchemaNode {
  name: string;
  relations: RelationNode[];
}

export interface SchemaTree {
  schemas: SchemaNode[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
  /** "GENERATED ALWAYS AS (…) STORED" or an identity clause. */
  generated: string | null;
  primaryKey: boolean;
  comment: string | null;
}

export interface TableStructure {
  columns: ColumnInfo[];
  indexes: { name: string; definition: string; unique: boolean; primary: boolean; size: string }[];
  constraints: { name: string; kind: string; definition: string }[];
  estimatedRows: number;
  totalSize: string | null;
  definition: string | null;
  comment: string | null;
}

export type Cell = string | null;

export interface ResultSet {
  columns: string[];
  rows: Cell[][];
  /** Rows returned or affected; more than `rows.length` when truncated. */
  rowCount: number;
  hasRows: boolean;
  truncated: boolean;
}

/** A query tab's own session: none yet, idle, inside a transaction, or (Postgres) aborted. */
export type TxState = "none" | "idle" | "open" | "aborted" | "unknown";

export interface QueryOutput {
  results: ResultSet[];
  durationMs: number;
  /** Cancelled past the row limit: rows kept, but the rest of the batch didn't run. */
  canceled: boolean;
}

export type FilterOp =
  | "="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">="
  | "contains"
  | "not contains"
  | "starts with"
  | "is null"
  | "is not null";

export interface Filter {
  column: string;
  op: FilterOp;
  value: string;
  /** Compare as text, for types without = (json, xml, geometric). */
  asText?: boolean;
}

export interface TableQuery {
  schema: string;
  table: string;
  limit: number;
  offset: number;
  sort?: { column: string; desc: boolean } | null;
  filters?: Filter[];
  whereRaw?: string | null;
}

export interface TableRows {
  sql: string;
  result: ResultSet;
  durationMs: number;
}

export type ExportFormat = "csv" | "json" | "sql";

export type ExportSource = { kind: "table"; query: TableQuery } | { kind: "sql"; sql: string };

export interface ExportArgs {
  id: string;
  queryId: string;
  source: ExportSource;
  format: ExportFormat;
  /** Absolute, or starting with `~/`. */
  path: string;
  /** Replace an existing file; without it, an existing one fails with code `exists`. */
  overwrite?: boolean;
  /** Table name for SQL INSERTs. */
  target?: string;
  /** Query tab id: run on the tab's own connection. */
  editor?: string;
}

export interface ExportResult {
  path: string;
  rows: number;
  bytes: number;
  durationMs: number;
}

export interface HistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  ranAt: number;
  durationMs: number;
  rowCount: number | null;
  error: string | null;
}

const BRIDGE: string | undefined = import.meta.env.VITE_DBOTTER_BRIDGE;
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Normalizes anything thrown into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "message" in e) return e as AppError;
  return { message: String(e) };
}

async function call<T>(cmd: string, args?: unknown): Promise<T> {
  if (inTauri) {
    try {
      return await invoke<T>("api", { cmd, args: args ?? null });
    } catch (e) {
      throw toAppError(e);
    }
  }
  if (!BRIDGE) throw { message: "Not running inside DbOtter (no Tauri IPC and no dev bridge)." } satisfies AppError;
  let res: Response;
  try {
    res = await fetch(`${BRIDGE}/api`, { method: "POST", body: JSON.stringify({ cmd, args: args ?? null }) });
  } catch {
    throw { message: `Dev bridge not reachable at ${BRIDGE}` } satisfies AppError;
  }
  const body = await res.json();
  if (!res.ok) throw body as AppError;
  return body as T;
}

export const newId = () => crypto.randomUUID();

export const api = {
  connections: () => call<ConnectionConfig[]>("connections_list"),
  saveConnection: (input: ConnectionInput) => call<ConnectionConfig>("connection_save", { input }),
  deleteConnection: (id: string) => call<void>("connection_delete", { id }),
  testConnection: (input: ConnectionInput) =>
    call<{ product: string; serverVersion: string; latencyMs: number }>("connection_test", { input }),
  connect: (id: string, password?: string, remember = false) =>
    call<SessionInfo>("connect", { id, password, remember }),
  disconnect: (id: string) => call<void>("disconnect", { id }),
  schema: (id: string) => call<SchemaTree>("schema", { id }),
  structure: (id: string, schema: string, table: string) =>
    call<TableStructure>("table_structure", { id, schema, table }),
  tableRows: (id: string, queryId: string, query: TableQuery) => call<TableRows>("table_rows", { id, queryId, query }),
  tableCount: (id: string, queryId: string, query: TableQuery) => call<number>("table_count", { id, queryId, query }),
  /** `editor`: the query tab id; it gets its own connection (transactions, SET… persist). */
  run: (id: string, queryId: string, sql: string, maxRows?: number, editor?: string) =>
    call<QueryOutput>("run_query", { id, queryId, sql, maxRows, editor }),
  releaseEditor: (editor: string) => call<void>("editor_release", { editor }),
  transactionStatus: (id: string, editor: string) => call<TxState>("transaction_status", { id, editor }),
  cancel: (queryId: string) => call<boolean>("cancel_query", { queryId }),
  /** Streams every row to a file; cancel with `cancel(queryId)`. */
  export: (args: ExportArgs) => call<ExportResult>("export", args),
  /** Default folder for exports (Downloads, else home). */
  exportDir: () => call<string>("export_dir"),
  /** Opens the file manager with the file selected. */
  revealPath: (path: string) => call<void>("reveal_path", { path }),
  history: (limit = 300) => call<HistoryEntry[]>("history_list", { limit }),
  clearHistory: () => call<void>("history_clear"),
};
