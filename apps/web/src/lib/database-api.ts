import type {
  AddColumnBody,
  Cell,
  ColumnSpec,
  CreateTableBody,
  CreateUserBody,
  DatabaseConnectionCreate,
  DatabaseConnectionSummary,
  DatabaseConnectionUpdate,
  DatabaseSummary,
  DbUser,
  ExportFormat,
  GrantBody,
  ImportResult,
  IndexSpec,
  RowPage,
  RowsQuery,
  StatementResult,
  TableDetail,
  TableSummary,
} from "@ucch/protocol";

/**
 * The browser's side of the database routes. Same shape as `files-api.ts`:
 * a thrown `Error` carries the server's own sentence, which for a database
 * is usually the engine's own sentence.
 */
async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: init.body && typeof init.body === "string" ? { "content-type": "application/json", ...init.headers } : init.headers,
  });
  if (!response.ok) await fail(response, fallback);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const json = (body: unknown) => JSON.stringify(body);

// --- connections -------------------------------------------------------------

export async function createConnection(workspaceId: string, input: DatabaseConnectionCreate): Promise<DatabaseConnectionSummary> {
  const result = await call<{ connection: DatabaseConnectionSummary }>(
    `/api/workspaces/${workspaceId}/database-connections`,
    { method: "POST", body: json(input) },
    "Could not save the connection.",
  );
  return result.connection;
}

/** Tests the changed credentials on the server before keeping them, like `createConnection`. */
export async function updateConnection(connectionId: string, input: DatabaseConnectionUpdate): Promise<DatabaseConnectionSummary> {
  const result = await call<{ connection: DatabaseConnectionSummary }>(
    `/api/database-connections/${connectionId}`,
    { method: "PATCH", body: json(input) },
    "Could not save the connection.",
  );
  return result.connection;
}

export async function fetchDatabases(connectionId: string): Promise<string[]> {
  const result = await call<{ databases: string[] }>(`/api/database-connections/${connectionId}/databases`, {}, "Could not list the databases.");
  return result.databases;
}

export async function fetchDatabaseDetails(connectionId: string): Promise<DatabaseSummary[]> {
  const result = await call<{ details: DatabaseSummary[] }>(`/api/database-connections/${connectionId}/databases`, {}, "Could not list the databases.");
  return result.details;
}

export async function createDatabase(connectionId: string, name: string): Promise<void> {
  await call(`/api/database-connections/${connectionId}/databases`, { method: "POST", body: json({ name }) }, "Could not create the database.");
}

export async function dropDatabase(connectionId: string, db: string): Promise<void> {
  await call(`/api/database-connections/${connectionId}/databases/${encodeURIComponent(db)}`, { method: "DELETE" }, "Could not drop the database.");
}

/**
 * The sidebar lists a connection's databases from its own lazy fetch, so a
 * database made or dropped from a page has to tell it. A window event
 * rather than a store: the two never otherwise share state.
 */
const DATABASES_CHANGED = "ucch:databases-changed";

export function announceDatabasesChanged(connectionId: string): void {
  window.dispatchEvent(new CustomEvent(DATABASES_CHANGED, { detail: { connectionId } }));
}

/** Calls back with the connection whose databases changed; returns the unsubscribe. */
export function onDatabasesChanged(listener: (connectionId: string) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<{ connectionId: string }>).detail.connectionId);
  window.addEventListener(DATABASES_CHANGED, handle);
  return () => window.removeEventListener(DATABASES_CHANGED, handle);
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await call<void>(`/api/database-connections/${connectionId}`, { method: "DELETE" }, "Could not remove the connection.");
}

// --- one database --------------------------------------------------------------

/** Every call below is about one database on one connection. */
export interface DbRef {
  connectionId: string;
  db: string;
}

function base({ connectionId, db }: DbRef): string {
  return `/api/database-connections/${encodeURIComponent(connectionId)}/db/${encodeURIComponent(db)}`;
}

const t = (ref: DbRef, table: string) => `${base(ref)}/tables/${encodeURIComponent(table)}`;

export async function fetchTables(ref: DbRef): Promise<TableSummary[]> {
  return (await call<{ tables: TableSummary[] }>(`${base(ref)}/tables`, {}, "Could not list the tables.")).tables;
}

export function fetchTable(ref: DbRef, table: string): Promise<TableDetail> {
  return call(t(ref, table), {}, "Could not read the table.");
}

export async function fetchCreateSql(ref: DbRef, table: string): Promise<string> {
  return (await call<{ sql: string }>(`${t(ref, table)}/create-sql`, {}, "Could not read the table's definition.")).sql;
}

export function fetchRows(ref: DbRef, table: string, query: Partial<RowsQuery>): Promise<RowPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return call(`${t(ref, table)}/rows?${params}`, {}, "Could not read the rows.");
}

export function insertRow(ref: DbRef, table: string, values: Record<string, Cell>): Promise<{ row?: Cell[]; insertId?: string }> {
  return call(`${t(ref, table)}/rows`, { method: "POST", body: json({ values }) }, "Could not insert the row.");
}

export async function updateRow(ref: DbRef, table: string, key: Record<string, Cell>, values: Record<string, Cell>): Promise<void> {
  await call(`${t(ref, table)}/rows`, { method: "PATCH", body: json({ key, values }) }, "Could not update the row.");
}

export function deleteRows(ref: DbRef, table: string, keys: Record<string, Cell>[]): Promise<{ affected: number }> {
  return call(`${t(ref, table)}/rows`, { method: "DELETE", body: json({ keys }) }, "Could not delete the rows.");
}

export async function runSql(ref: DbRef, sql: string, opts: { maxRows?: number; continueOnError?: boolean } = {}): Promise<StatementResult[]> {
  return (await call<{ results: StatementResult[] }>(`${base(ref)}/sql`, { method: "POST", body: json({ sql, ...opts }) }, "Could not run the SQL.")).results;
}

// --- structure -----------------------------------------------------------------

export async function createTable(ref: DbRef, spec: CreateTableBody): Promise<void> {
  await call(`${base(ref)}/tables`, { method: "POST", body: json(spec) }, "Could not create the table.");
}

export async function renameTable(ref: DbRef, table: string, name: string): Promise<void> {
  await call(t(ref, table), { method: "PATCH", body: json({ name }) }, "Could not rename the table.");
}

export async function dropTable(ref: DbRef, table: string): Promise<void> {
  await call(t(ref, table), { method: "DELETE" }, "Could not drop the table.");
}

export async function truncateTable(ref: DbRef, table: string): Promise<void> {
  await call(`${t(ref, table)}/truncate`, { method: "POST" }, "Could not empty the table.");
}

export async function addColumn(ref: DbRef, table: string, body: AddColumnBody): Promise<void> {
  await call(`${t(ref, table)}/columns`, { method: "POST", body: json(body) }, "Could not add the column.");
}

export async function modifyColumn(ref: DbRef, table: string, column: string, spec: ColumnSpec): Promise<void> {
  await call(`${t(ref, table)}/columns/${encodeURIComponent(column)}`, { method: "PATCH", body: json({ column: spec }) }, "Could not change the column.");
}

export async function dropColumn(ref: DbRef, table: string, column: string): Promise<void> {
  await call(`${t(ref, table)}/columns/${encodeURIComponent(column)}`, { method: "DELETE" }, "Could not drop the column.");
}

export async function addIndex(ref: DbRef, table: string, spec: IndexSpec): Promise<void> {
  await call(`${t(ref, table)}/indexes`, { method: "POST", body: json(spec) }, "Could not add the index.");
}

export async function dropIndex(ref: DbRef, table: string, index: string): Promise<void> {
  await call(`${t(ref, table)}/indexes/${encodeURIComponent(index)}`, { method: "DELETE" }, "Could not drop the index.");
}

// --- import / export -----------------------------------------------------------

export function exportUrl(ref: DbRef, opts: { format: ExportFormat; tables?: string[]; create?: boolean; data?: boolean; drop?: boolean }): string {
  const params = new URLSearchParams({ format: opts.format });
  if (opts.tables && opts.tables.length > 0) params.set("tables", opts.tables.join(","));
  if (opts.create !== undefined) params.set("create", opts.create ? "1" : "0");
  if (opts.data !== undefined) params.set("data", opts.data ? "1" : "0");
  if (opts.drop !== undefined) params.set("drop", opts.drop ? "1" : "0");
  return `${base(ref)}/export?${params}`;
}

export function importFile(
  ref: DbRef,
  file: File,
  opts: { format: ExportFormat; table?: string; continueOnError?: boolean; emptyAsNull?: boolean },
): Promise<ImportResult> {
  const params = new URLSearchParams({ format: opts.format });
  if (opts.table) params.set("table", opts.table);
  if (opts.continueOnError !== undefined) params.set("continueOnError", opts.continueOnError ? "1" : "0");
  if (opts.emptyAsNull !== undefined) params.set("emptyAsNull", opts.emptyAsNull ? "1" : "0");
  return call(`${base(ref)}/import?${params}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file }, "Could not import the file.");
}

// --- users ---------------------------------------------------------------------

export async function fetchUsers(ref: DbRef): Promise<DbUser[]> {
  return (await call<{ users: DbUser[] }>(`${base(ref)}/users`, {}, "Could not list the users.")).users;
}

export async function createUser(ref: DbRef, body: CreateUserBody): Promise<void> {
  await call(`${base(ref)}/users`, { method: "POST", body: json(body) }, "Could not create the user.");
}

export async function dropUser(ref: DbRef, name: string, opts: { host?: string; force?: boolean } = {}): Promise<void> {
  const params = new URLSearchParams();
  if (opts.host) params.set("host", opts.host);
  if (opts.force) params.set("force", "1");
  await call(`${base(ref)}/users/${encodeURIComponent(name)}?${params}`, { method: "DELETE" }, "Could not drop the user.");
}

export async function grantPrivileges(ref: DbRef, name: string, body: GrantBody): Promise<void> {
  await call(`${base(ref)}/users/${encodeURIComponent(name)}/grant`, { method: "POST", body: json(body) }, "Could not grant the privileges.");
}

export async function revokePrivileges(ref: DbRef, name: string, body: GrantBody): Promise<void> {
  await call(`${base(ref)}/users/${encodeURIComponent(name)}/revoke`, { method: "POST", body: json(body) }, "Could not revoke the privileges.");
}
