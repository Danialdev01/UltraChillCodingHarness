import type {
  AddColumnBody,
  Cell,
  ColumnInfo,
  ColumnSpec,
  CreateTableBody,
  DatabaseEngine,
  DatabaseSummary,
  DbUser,
  IndexSpec,
  RowPage,
  RowsQuery,
  StatementResult,
  TableDetail,
  TableSummary,
} from "@ucch/protocol";

/**
 * What every engine must be able to do for the database views, and the
 * errors they agree on.
 *
 * Each adapter method opens its own connection and closes it before
 * returning; nothing is pooled because the servers are the user's and may
 * be gone by the next request. Methods that need several statements in
 * one session (a PostgreSQL column change, a CSV import) do them inside a
 * single `withConnection` call.
 */
export interface DbTarget {
  engine: DatabaseEngine;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string | null;
}

/** The server could not be reached or would not let us in: 502. */
export class DbConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbConnectError";
  }
}

/** The server ran the statement and rejected it: 400, with its own words. */
export class DbQueryError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DbQueryError";
  }
}

/** We would not run it: no primary key, wrong shape, and so on: 422. */
export class DbRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbRefusal";
  }
}

const CONNECT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "CONNECT_TIMEOUT",
  "PROTOCOL_CONNECTION_LOST", "ER_ACCESS_DENIED_ERROR", "28P01", "3D000", "57P01", "08006", "08001",
]);

/**
 * A driver error as one of ours. Driver messages name the host and user but
 * never the password; the cap keeps a stack-shaped message from becoming
 * the whole dialog.
 */
export function toDbError(error: unknown, phase: "connect" | "query"): DbConnectError | DbQueryError {
  if (error instanceof DbConnectError || error instanceof DbQueryError || error instanceof DbRefusal) {
    return error as DbConnectError;
  }
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
  const raw = error instanceof Error ? error.message : String(error);
  const line = raw.split("\n")[0]?.trim() || "the server returned an error";
  const message = line.length > 300 ? `${line.slice(0, 299)}…` : line;
  if (phase === "connect" || (code && CONNECT_CODES.has(code))) return new DbConnectError(message);
  return new DbQueryError(message, code);
}

/** Rejects after `ms`; the caller's `finally` is what actually closes the socket. */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return work;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DbConnectError("the server did not answer in time")), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ConnOpts {
  /** Statement timeout in ms; 0 for none (export, import). Default 60 s. */
  timeoutMs?: number;
}

export interface SqlRunOpts {
  maxRows: number;
  continueOnError: boolean;
  timeoutMs?: number;
}

export interface CsvImportOpts {
  emptyAsNull: boolean;
}

export interface GrantSpec {
  name: string;
  host?: string;
  privileges: string[];
  connect?: boolean;
}

export interface DbAdapter {
  readonly engine: DatabaseEngine;
  ping(): Promise<void>;
  listDatabases(): Promise<string[]>;
  /** The same list with what the engine knows about each one's size. */
  describeDatabases(): Promise<DatabaseSummary[]>;
  createDatabase(name: string): Promise<void>;
  dropDatabase(name: string): Promise<void>;

  listTables(): Promise<TableSummary[]>;
  describeTable(table: string): Promise<TableDetail>;
  browse(table: string, query: RowsQuery): Promise<RowPage>;

  insertRow(table: string, values: Record<string, Cell>): Promise<{ row?: Cell[]; insertId?: string }>;
  updateRow(table: string, key: Record<string, Cell>, values: Record<string, Cell>): Promise<void>;
  deleteRows(table: string, keys: Record<string, Cell>[]): Promise<{ affected: number }>;
  runSql(text: string, opts: SqlRunOpts): Promise<StatementResult[]>;

  createTable(spec: CreateTableBody): Promise<void>;
  renameTable(table: string, name: string): Promise<void>;
  dropTable(table: string): Promise<void>;
  truncateTable(table: string): Promise<void>;
  addColumn(table: string, spec: AddColumnBody): Promise<void>;
  modifyColumn(table: string, column: string, spec: ColumnSpec): Promise<void>;
  dropColumn(table: string, column: string): Promise<void>;
  addIndex(table: string, spec: IndexSpec): Promise<void>;
  dropIndex(table: string, index: string): Promise<void>;

  createTableSql(table: string): Promise<string>;
  /** Every row of a table, in batches, on a connection of its own. */
  streamRows(table: string, columns: string[]): AsyncIterable<unknown[][]>;
  /** A driver value as a SQL literal for a dump. */
  literal(value: unknown, column: ColumnInfo): string;
  importCsv(table: string, header: string[], rows: string[][], opts: CsvImportOpts): Promise<{ inserted: number }>;

  listUsers(): Promise<DbUser[]>;
  createUser(name: string, password: string, host?: string): Promise<void>;
  dropUser(name: string, host?: string, force?: boolean): Promise<void>;
  grant(spec: GrantSpec): Promise<void>;
  revoke(spec: GrantSpec): Promise<void>;
}

/** Shared by both adapters: the column list a query may name. */
export function requireColumns(detail: TableDetail, names: Iterable<string>, what: string): void {
  const known = new Set(detail.columns.map((c) => c.name));
  for (const name of names) {
    if (!known.has(name)) throw new DbQueryError(`${what}: unknown column "${name}"`);
  }
}

export function requireKey(detail: TableDetail, key: Record<string, Cell>): string[] {
  if (detail.tableType === "view") throw new DbRefusal("a view cannot be edited in place");
  if (detail.primaryKey.length === 0) throw new DbRefusal("this table has no primary key, so its rows cannot be edited in place");
  for (const column of detail.primaryKey) {
    if (!(column in key)) throw new DbQueryError(`key: missing primary key column "${column}"`);
  }
  return detail.primaryKey;
}

export const STATEMENT_PREVIEW = 200;

export function preview(statement: string): string {
  const line = statement.replace(/\s+/g, " ").trim();
  return line.length > STATEMENT_PREVIEW ? `${line.slice(0, STATEMENT_PREVIEW - 1)}…` : line;
}
