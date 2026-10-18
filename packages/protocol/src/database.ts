import { z } from "zod";

/**
 * What the Database view and its routes say to each other.
 *
 * A connection is a server, not a database: the server is what the user has
 * credentials for, and the databases behind it are listed live rather than
 * stored. The password crosses the wire once, on creation, and never comes
 * back -- `DatabaseConnectionSummary` has no field for it.
 */

export const DatabaseEngine = z.enum(["mysql", "postgresql"]);
export type DatabaseEngine = z.infer<typeof DatabaseEngine>;

export const DEFAULT_DB_PORTS: Record<DatabaseEngine, number> = {
  mysql: 3306,
  postgresql: 5432,
};

/**
 * The name of a development database a project asks the harness to create.
 *
 * Narrower than either engine allows, on purpose: lower-case, starting with a
 * letter, letters/digits/underscores only. It is the same identifier on MySQL
 * and PostgreSQL without quoting, and it is safe in a URL and a `.env` file.
 */
export const DevDatabaseName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "lower-case letters, digits and underscores, starting with a letter");
export type DevDatabaseName = z.infer<typeof DevDatabaseName>;

/** A project's own development database: which shared server, and its name. */
export const ProjectDatabase = z.object({ engine: DatabaseEngine, name: DevDatabaseName });
export type ProjectDatabase = z.infer<typeof ProjectDatabase>;

/** Turns a project name into a database name a person would probably pick. */
export function suggestDevDatabaseName(projectName: string): string {
  const cleaned = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 63);
  return cleaned;
}

export const DATABASE_ENGINE_LABELS: Record<DatabaseEngine, string> = {
  mysql: "MySQL",
  postgresql: "PostgreSQL",
};

export const DatabaseConnectionCreate = z.object({
  name: z.string().trim().min(1).max(80),
  engine: DatabaseEngine,
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1).max(255),
  /** Empty is allowed: a local server with no password is still a server. */
  password: z.string().max(1024),
  database: z.string().trim().max(255).optional(),
});
export type DatabaseConnectionCreate = z.infer<typeof DatabaseConnectionCreate>;

/**
 * A change to a saved connection. Every field is optional, and the password
 * most of all: the form never sees the stored one, so leaving it out means
 * "keep it" rather than "clear it".
 */
export const DatabaseConnectionUpdate = DatabaseConnectionCreate.partial();
export type DatabaseConnectionUpdate = z.infer<typeof DatabaseConnectionUpdate>;

export interface DatabaseConnectionSummary {
  id: string;
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: number;
  username: string;
  database: string | null;
  /** ISO date. */
  createdAt: string;
}

/** One database on a server, as the connection page lists them. */
export interface DatabaseSummary {
  name: string;
  /** On disk, as the engine reports it; null when the credentials cannot ask. */
  sizeBytes: number | null;
  /** Tables and views; null when counting would mean a connection per database (PostgreSQL). */
  tables: number | null;
}

export const CreateDatabaseBody = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "letters, digits and underscores; must not start with a digit"),
});
export type CreateDatabaseBody = z.infer<typeof CreateDatabaseBody>;

// ---------------------------------------------------------------------------
// The database manager: what the Structure / Data / SQL / Import / Export /
// Permissions views and their routes say to each other.
// ---------------------------------------------------------------------------

/**
 * A cell as JSON carries it. Binary comes as base64 with its true size, cut
 * at 16 KiB so a row of blobs does not become a page of blobs; `truncated`
 * marks the cut and makes the cell read-only in the grid.
 */
export const CellSchema = z.union([
  z.null(),
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ $bytes: z.string(), size: z.number().int().min(0), truncated: z.literal(true).optional() }),
]);
export type Cell = z.infer<typeof CellSchema>;

export type CellKind =
  | "number"
  | "text"
  | "bool"
  | "date"
  | "datetime"
  | "time"
  | "json"
  | "bytes"
  | "enum"
  | "other";

export type TableType = "table" | "view";

export interface TableSummary {
  name: string;
  tableType: TableType;
  /** The engine's estimate; null for views. */
  rowEstimate: number | null;
  sizeBytes: number | null;
  comment: string | null;
}

export interface ColumnInfo {
  name: string;
  /** The full type as the engine prints it: `varchar(255)`, `timestamp with time zone`. */
  type: string;
  /** The bare type family used to pick `kind`. */
  dataType: string;
  kind: CellKind;
  nullable: boolean;
  default: string | null;
  primary: boolean;
  unique: boolean;
  autoincrement: boolean;
  generated: boolean;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  type: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableDetail {
  name: string;
  tableType: TableType;
  columns: ColumnInfo[];
  primaryKey: string[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export const ROW_PAGE_SIZES = [25, 100, 500] as const;

export const RowsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
  sort: z.string().max(64).optional(),
  dir: z.enum(["asc", "desc"]).default("asc"),
  /** A quick text search across the text-like columns. */
  q: z.string().max(200).optional(),
  /** A raw WHERE fragment, run as-is under the user's own credentials. */
  where: z.string().max(2000).optional(),
});
export type RowsQuery = z.infer<typeof RowsQuery>;

export interface RowPage {
  columns: ColumnInfo[];
  primaryKey: string[];
  /** No primary key, or a view: rows can be read but not edited in place. */
  readOnly: boolean;
  rows: Cell[][];
  total: number;
  /** False when `total` is the engine's estimate rather than a count. */
  exact: boolean;
  page: number;
  pageSize: number;
}

const CellRecord = z.record(z.string().max(64), CellSchema);

export const RowInsertBody = z.object({ values: CellRecord });
export type RowInsertBody = z.infer<typeof RowInsertBody>;
export const RowUpdateBody = z.object({ key: CellRecord, values: CellRecord });
export type RowUpdateBody = z.infer<typeof RowUpdateBody>;
export const RowDeleteBody = z.object({ keys: z.array(CellRecord).min(1).max(500) });
export type RowDeleteBody = z.infer<typeof RowDeleteBody>;

export const SQL_MAX_BYTES = 1024 * 1024;

export const SqlBody = z.object({
  sql: z.string().min(1).max(SQL_MAX_BYTES),
  maxRows: z.number().int().min(1).max(5000).default(1000),
  continueOnError: z.boolean().default(false),
});
export type SqlBody = z.infer<typeof SqlBody>;

export interface StatementResult {
  /** The statement, cut to 200 characters for the result heading. */
  statement: string;
  durationMs: number;
  columns?: string[];
  rows?: Cell[][];
  truncated?: boolean;
  affectedRows?: number;
  insertId?: string;
  command?: string;
  error?: string;
}

// --- Structure -------------------------------------------------------------

/** A name for something being created: plain enough to never need quoting. */
export const Identifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, "letters, digits and underscores; must not start with a digit");
/** A name for something that already exists, whatever it is called; always quoted. */
export const ExistingName = z.string().min(1).max(64).regex(/^[^`"\x00-\x1f]+$/);
export const DbName = z.string().min(1).max(64).regex(/^[^`"\x00-\x1f/\\]+$/);
export const TypeText = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_ (),'[\]]+$/, "a type like varchar(255), integer or timestamp with time zone")
  .refine(balancedQuotes, "unbalanced quotes");
export const DefaultExpr = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_ ().,:'+\-]+$/, "an expression like CURRENT_TIMESTAMP or now()")
  .refine(balancedQuotes, "unbalanced quotes");
export const MysqlHost = z.string().min(1).max(255).regex(/^[A-Za-z0-9_.%:\-]+$/);
export const DbPassword = z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/, "printable ASCII only");

function balancedQuotes(text: string): boolean {
  return (text.match(/'/g) ?? []).length % 2 === 0;
}

export const ColumnDefault = z.union([
  z.object({ kind: z.literal("literal"), value: z.string().max(1024) }),
  z.object({ kind: z.literal("expression"), value: DefaultExpr }),
]);
export type ColumnDefault = z.infer<typeof ColumnDefault>;

export const ColumnSpec = z.object({
  name: Identifier,
  type: TypeText,
  nullable: z.boolean().default(true),
  autoincrement: z.boolean().default(false),
  default: ColumnDefault.nullable().default(null),
  primaryKey: z.boolean().default(false),
  unique: z.boolean().default(false),
  comment: z.string().max(1024).optional(),
});
export type ColumnSpec = z.infer<typeof ColumnSpec>;

export const CreateTableBody = z.object({
  name: Identifier,
  columns: z.array(ColumnSpec).min(1).max(200),
});
export type CreateTableBody = z.infer<typeof CreateTableBody>;

export const RenameTableBody = z.object({ name: Identifier });
export const AddColumnBody = z.object({ column: ColumnSpec, after: ExistingName.optional() });
export type AddColumnBody = z.infer<typeof AddColumnBody>;
export const ModifyColumnBody = z.object({ column: ColumnSpec });
export const IndexSpec = z.object({
  name: Identifier,
  columns: z.array(ExistingName).min(1).max(16),
  unique: z.boolean().default(false),
});
export type IndexSpec = z.infer<typeof IndexSpec>;

// --- Import / export ---------------------------------------------------------

const QueryBool = z.union([
  z.boolean(),
  z.enum(["0", "1", "true", "false"]).transform((v) => v === "1" || v === "true"),
]);

export const ExportFormat = z.enum(["sql", "csv"]);
export type ExportFormat = z.infer<typeof ExportFormat>;

export const ExportQuery = z.object({
  format: ExportFormat,
  /** Comma-separated table names; all tables when absent. CSV needs exactly one. */
  tables: z.string().max(4096).optional(),
  create: QueryBool.default(true),
  data: QueryBool.default(true),
  drop: QueryBool.default(false),
});
export type ExportQuery = z.infer<typeof ExportQuery>;

export const ImportQuery = z.object({
  format: ExportFormat,
  table: ExistingName.optional(),
  continueOnError: QueryBool.default(false),
  emptyAsNull: QueryBool.default(true),
});
export type ImportQuery = z.infer<typeof ImportQuery>;

export type ImportResult =
  | { format: "sql"; statements: number; executed: number; durationMs: number; failed?: { index: number; statement: string; error: string } }
  | { format: "csv"; inserted: number; durationMs: number };

// --- Permissions -------------------------------------------------------------

export const MYSQL_PRIVILEGES = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES",
  "CREATE VIEW", "SHOW VIEW", "TRIGGER", "EXECUTE", "EVENT", "CREATE ROUTINE", "ALTER ROUTINE",
  "LOCK TABLES", "CREATE TEMPORARY TABLES", "ALL",
] as const;
export const PG_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "ALL"] as const;

export function privilegesFor(engine: DatabaseEngine): readonly string[] {
  return engine === "mysql" ? MYSQL_PRIVILEGES : PG_PRIVILEGES;
}

export const CreateUserBody = z.object({
  name: Identifier,
  host: MysqlHost.optional(),
  password: DbPassword,
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const GrantBody = z.object({
  host: MysqlHost.optional(),
  privileges: z.array(z.string().max(32)).min(1).max(32),
  /** Revoke only: also take away CONNECT on the database (PostgreSQL). */
  connect: z.boolean().optional(),
});
export type GrantBody = z.infer<typeof GrantBody>;

export const DropUserQuery = z.object({
  host: MysqlHost.optional(),
  force: QueryBool.default(false),
});

export interface DbUser {
  name: string;
  /** MySQL accounts are `user@host`; null for PostgreSQL roles. */
  host: string | null;
  /** Privileges on the open database (MySQL) or its public tables (PostgreSQL). */
  privileges: string[];
  /** MySQL global privileges, which apply here too. */
  global: string[];
  /** PostgreSQL: connect / create on the database; login, superuser, and so on. */
  flags: Record<string, boolean>;
}
