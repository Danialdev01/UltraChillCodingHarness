import { createConnection, type Connection, type ResultSetHeader } from "mysql2/promise";
import type { Connection as CallbackConnection } from "mysql2";
import type {
  DatabaseSummary,
  AddColumnBody,
  Cell,
  ColumnInfo,
  ColumnSpec,
  CreateTableBody,
  DbUser,
  ForeignKeyInfo,
  IndexInfo,
  IndexSpec,
  RowPage,
  RowsQuery,
  StatementResult,
  TableDetail,
  TableSummary,
} from "@ucch/protocol";
import { MYSQL_PRIVILEGES } from "@ucch/protocol";
import {
  DbQueryError,
  DbRefusal,
  preview,
  requireColumns,
  requireKey,
  toDbError,
  withDeadline,
  type ConnOpts,
  type CsvImportOpts,
  type DbAdapter,
  type DbTarget,
  type GrantSpec,
  type SqlRunOpts,
} from "./adapter.js";
import { columnDdl } from "./ddl.js";
import { bindValue, cellKindFor, serializeCell } from "./serialize.js";
import { escapeLike, mysqlAccount, qualified, quoteIdent, quoteLiteral } from "./sql-ident.js";
import { splitStatements } from "./sql-split.js";

const CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_STATEMENT_MS = 60_000;
const DEADLINE_MS = 90_000;
const MAX_DATABASES = 500;
const COUNT_LIMIT = 500_000;
const BATCH = 500;

type Row = Record<string, unknown>;

/**
 * One MySQL session for one job.
 *
 * Text is asked for wherever the driver would otherwise guess: dates and
 * big numbers as strings (JSON has neither), JSON columns as their text.
 * `FOUND_ROWS` makes UPDATE report matched rows rather than changed ones,
 * so writing a row back unchanged still counts as finding it.
 */
export async function withMysql<T>(
  target: DbTarget,
  database: string | null,
  fn: (c: Connection) => Promise<T>,
  opts: ConnOpts = {},
): Promise<T> {
  let c: Connection | undefined;
  try {
    c = await createConnection({
      host: target.host,
      port: target.port,
      user: target.username,
      password: target.password,
      database: database ?? target.database ?? undefined,
      connectTimeout: CONNECT_TIMEOUT_MS,
      multipleStatements: false,
      flags: ["+FOUND_ROWS"],
      supportBigNumbers: true,
      bigNumberStrings: false,
      dateStrings: true,
      jsonStrings: true,
    });
  } catch (error) {
    throw toDbError(error, "connect");
  }
  try {
    const timeout = opts.timeoutMs ?? DEFAULT_STATEMENT_MS;
    // SELECT-only, and MariaDB spells it differently: best effort.
    if (timeout > 0) await c.query("SET SESSION max_execution_time = ?", [timeout]).catch(() => {});
    return await fn(c);
  } catch (error) {
    throw toDbError(error, "query");
  } finally {
    await c.end().catch(() => c?.destroy());
  }
}

export class MysqlAdapter implements DbAdapter {
  readonly engine = "mysql" as const;

  constructor(
    private readonly target: DbTarget,
    private readonly db: string | null,
  ) {}

  #run<T>(fn: (c: Connection) => Promise<T>, opts: ConnOpts = {}, deadline = DEADLINE_MS): Promise<T> {
    return withDeadline(withMysql(this.target, this.db, fn, opts), deadline);
  }

  #db(): string {
    if (!this.db) throw new DbRefusal("no database selected");
    return this.db;
  }

  #q(table: string): string {
    return qualified("mysql", this.#db(), table);
  }

  async ping(): Promise<void> {
    await this.#run((c) => c.query("SELECT 1"), {}, 10_000);
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.#run(async (c) => (await c.query("SHOW DATABASES"))[0] as Row[], {}, 10_000);
    return rows
      .map((row) => String(Object.values(row)[0]))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_DATABASES);
  }

  async describeDatabases(): Promise<DatabaseSummary[]> {
    const rows = await this.#run(
      async (c) =>
        (
          await c.query(
            `select s.schema_name as name, sum(t.data_length + t.index_length) as size, count(t.table_name) as tables
             from information_schema.schemata s
             left join information_schema.tables t on t.table_schema = s.schema_name
             group by s.schema_name order by s.schema_name`,
          )
        )[0] as Row[],
      {},
      10_000,
    );
    return rows
      .map((row) => ({
        name: String(row.name),
        sizeBytes: row.size === null || row.size === undefined ? null : Number(row.size),
        tables: Number(row.tables ?? 0),
      }))
      .slice(0, MAX_DATABASES);
  }

  async createDatabase(name: string): Promise<void> {
    await this.#run((c) => c.query(`CREATE DATABASE ${quoteIdent("mysql", name)}`), {}, 30_000);
  }

  async dropDatabase(name: string): Promise<void> {
    await this.#run((c) => c.query(`DROP DATABASE ${quoteIdent("mysql", name)}`), {}, 60_000);
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = await this.#run(
      async (c) =>
        (
          await c.query(
            `SELECT TABLE_NAME AS name, TABLE_TYPE AS tableType, TABLE_ROWS AS rowEstimate,
                    IFNULL(DATA_LENGTH, 0) + IFNULL(INDEX_LENGTH, 0) AS sizeBytes, TABLE_COMMENT AS comment
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
            [this.#db()],
          )
        )[0] as Row[],
    );
    return rows.map((row) => {
      const view = String(row.tableType) === "VIEW";
      return {
        name: String(row.name),
        tableType: view ? "view" : "table",
        rowEstimate: view || row.rowEstimate === null ? null : Number(row.rowEstimate),
        sizeBytes: view ? null : Number(row.sizeBytes),
        comment: row.comment ? String(row.comment) : null,
      };
    });
  }

  async describeTable(table: string): Promise<TableDetail> {
    return this.#run((c) => this.#describe(c, table));
  }

  async #describe(c: Connection, table: string): Promise<TableDetail> {
    const db = this.#db();
    const [[kindRows], [columnRows], [indexRows], [fkRows]] = await Promise.all([
      c.query("SELECT TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [db, table]),
      c.query(
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS dataType, IS_NULLABLE = 'YES' AS nullable,
                COLUMN_DEFAULT AS defaultValue, COLUMN_KEY AS columnKey, EXTRA AS extra, COLUMN_COMMENT AS comment
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [db, table],
      ),
      c.query(
        `SELECT INDEX_NAME AS name, NON_UNIQUE = 0 AS isUnique, INDEX_TYPE AS type, COLUMN_NAME AS col
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        [db, table],
      ),
      c.query(
        `SELECT kcu.CONSTRAINT_NAME AS name, kcu.COLUMN_NAME AS col, kcu.REFERENCED_TABLE_NAME AS refTable,
                kcu.REFERENCED_COLUMN_NAME AS refColumn, rc.UPDATE_RULE AS onUpdate, rc.DELETE_RULE AS onDelete
         FROM information_schema.KEY_COLUMN_USAGE kcu
         JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND rc.TABLE_NAME = kcu.TABLE_NAME
         WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
         ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`,
        [db, table],
      ),
    ]);
    const kind = (kindRows as Row[])[0];
    if (!kind) throw new DbQueryError(`table "${table}" does not exist`, "ER_NO_SUCH_TABLE");

    const columns: ColumnInfo[] = (columnRows as Row[]).map((row) => ({
      name: String(row.name),
      type: String(row.type),
      dataType: String(row.dataType),
      kind: cellKindFor("mysql", String(row.dataType), String(row.type)),
      nullable: Boolean(Number(row.nullable)),
      default: row.defaultValue === null ? null : String(row.defaultValue),
      primary: row.columnKey === "PRI",
      unique: row.columnKey === "UNI",
      autoincrement: /auto_increment/i.test(String(row.extra)),
      generated: /(VIRTUAL|STORED) GENERATED/i.test(String(row.extra)),
      comment: row.comment ? String(row.comment) : null,
    }));

    const indexes = new Map<string, IndexInfo>();
    for (const row of indexRows as Row[]) {
      const name = String(row.name);
      const index = indexes.get(name) ?? {
        name,
        columns: [],
        unique: Boolean(Number(row.isUnique)),
        primary: name === "PRIMARY",
        type: row.type ? String(row.type) : null,
      };
      index.columns.push(String(row.col));
      indexes.set(name, index);
    }

    const foreignKeys = new Map<string, ForeignKeyInfo>();
    for (const row of fkRows as Row[]) {
      const name = String(row.name);
      const fk = foreignKeys.get(name) ?? {
        name,
        columns: [],
        refTable: String(row.refTable),
        refColumns: [],
        onUpdate: String(row.onUpdate),
        onDelete: String(row.onDelete),
      };
      fk.columns.push(String(row.col));
      fk.refColumns.push(String(row.refColumn));
      foreignKeys.set(name, fk);
    }

    return {
      name: table,
      tableType: String(kind.t) === "VIEW" ? "view" : "table",
      columns,
      primaryKey: indexes.get("PRIMARY")?.columns ?? [],
      indexes: [...indexes.values()],
      foreignKeys: [...foreignKeys.values()],
    };
  }

  async browse(table: string, query: RowsQuery): Promise<RowPage> {
    return this.#run(async (c) => {
      const detail = await this.#describe(c, table);
      if (query.sort) requireColumns(detail, [query.sort], "sort");

      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.where?.trim()) clauses.push(`(${query.where})`);
      if (query.q?.trim()) {
        const searchable = detail.columns.filter((col) => col.kind === "text" || col.kind === "enum" || col.kind === "json");
        if (searchable.length > 0) {
          clauses.push(`(${searchable.map((col) => `${quoteIdent("mysql", col.name)} LIKE ?`).join(" OR ")})`);
          const like = `%${escapeLike(query.q.trim())}%`;
          for (let i = 0; i < searchable.length; i += 1) params.push(like);
        } else {
          clauses.push("(0)");
        }
      }
      const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
      const order = query.sort ? ` ORDER BY ${quoteIdent("mysql", query.sort)} ${query.dir === "desc" ? "DESC" : "ASC"}` : "";
      const offset = (query.page - 1) * query.pageSize;

      const [rows] = await c.query({
        sql: `SELECT * FROM ${this.#q(table)}${where}${order} LIMIT ? OFFSET ?`,
        values: [...params, query.pageSize, offset],
        rowsAsArray: true,
      });

      let total: number;
      let exact = true;
      const estimate = clauses.length === 0 ? await this.#estimate(c, table) : null;
      if (estimate !== null && estimate > COUNT_LIMIT) {
        total = estimate;
        exact = false;
      } else {
        const [[count]] = (await c.query(`SELECT COUNT(*) AS n FROM ${this.#q(table)}${where}`, params)) as [Row[], unknown];
        total = Number(count?.n ?? 0);
      }

      return {
        columns: detail.columns,
        primaryKey: detail.primaryKey,
        readOnly: detail.tableType === "view" || detail.primaryKey.length === 0,
        rows: (rows as unknown[][]).map((row) => row.map(serializeCell)),
        total,
        exact,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  async #estimate(c: Connection, table: string): Promise<number | null> {
    const [rows] = (await c.query(
      "SELECT TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
      [this.#db(), table],
    )) as [Row[], unknown];
    const n = rows[0]?.n;
    return n === null || n === undefined ? null : Number(n);
  }

  async insertRow(table: string, values: Record<string, Cell>): Promise<{ row?: Cell[]; insertId?: string }> {
    return this.#run(async (c) => {
      const detail = await this.#describe(c, table);
      const names = Object.keys(values);
      requireColumns(detail, names, "values");
      const sql =
        names.length === 0
          ? `INSERT INTO ${this.#q(table)} () VALUES ()`
          : `INSERT INTO ${this.#q(table)} (${names.map((n) => quoteIdent("mysql", n)).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
      const [result] = (await c.query(sql, names.map((n) => bindValue(values[n]!)))) as [ResultSetHeader, unknown];
      return result.insertId ? { insertId: String(result.insertId) } : {};
    });
  }

  async updateRow(table: string, key: Record<string, Cell>, values: Record<string, Cell>): Promise<void> {
    await this.#run(async (c) => {
      const detail = await this.#describe(c, table);
      const pk = requireKey(detail, key);
      const names = Object.keys(values);
      requireColumns(detail, names, "values");
      if (names.length === 0) return;
      const sql = `UPDATE ${this.#q(table)} SET ${names.map((n) => `${quoteIdent("mysql", n)} = ?`).join(", ")} WHERE ${pk
        .map((n) => `${quoteIdent("mysql", n)} <=> ?`)
        .join(" AND ")}`;
      const [result] = (await c.query(sql, [...names.map((n) => bindValue(values[n]!)), ...pk.map((n) => bindValue(key[n]!))])) as [
        ResultSetHeader,
        unknown,
      ];
      if (result.affectedRows !== 1) throw new DbQueryError(result.affectedRows === 0 ? "row not found" : "key matched more than one row");
    });
  }

  async deleteRows(table: string, keys: Record<string, Cell>[]): Promise<{ affected: number }> {
    return this.#run(async (c) => {
      const detail = await this.#describe(c, table);
      const pk = requireKey(detail, keys[0] ?? {});
      const params: unknown[] = [];
      const clauses = keys.map((key) => {
        requireKey(detail, key);
        for (const n of pk) params.push(bindValue(key[n]!));
        return `(${pk.map((n) => `${quoteIdent("mysql", n)} <=> ?`).join(" AND ")})`;
      });
      const [result] = (await c.query(`DELETE FROM ${this.#q(table)} WHERE ${clauses.join(" OR ")}`, params)) as [ResultSetHeader, unknown];
      return { affected: result.affectedRows };
    });
  }

  async runSql(text: string, opts: SqlRunOpts): Promise<StatementResult[]> {
    const statements = splitStatements(text, "mysql");
    return this.#run(
      async (c) => {
        const results: StatementResult[] = [];
        for (const statement of statements) {
          const started = performance.now();
          try {
            const [rows, fields] = await c.query({ sql: statement, rowsAsArray: true });
            const durationMs = Math.round(performance.now() - started);
            if (Array.isArray(rows)) {
              const all = rows as unknown[][];
              results.push({
                statement: preview(statement),
                durationMs,
                columns: (fields ?? []).map((f) => f.name),
                rows: all.slice(0, opts.maxRows).map((row) => row.map(serializeCell)),
                ...(all.length > opts.maxRows ? { truncated: true } : {}),
              });
            } else {
              const header = rows as ResultSetHeader;
              results.push({
                statement: preview(statement),
                durationMs,
                affectedRows: header.affectedRows,
                ...(header.insertId ? { insertId: String(header.insertId) } : {}),
              });
            }
          } catch (error) {
            const failure = toDbError(error, "query");
            results.push({ statement: preview(statement), durationMs: Math.round(performance.now() - started), error: failure.message });
            if (!opts.continueOnError) break;
          }
        }
        return results;
      },
      { timeoutMs: opts.timeoutMs ?? DEFAULT_STATEMENT_MS },
      opts.timeoutMs === 0 ? 0 : DEADLINE_MS,
    );
  }

  // --- structure -----------------------------------------------------------

  async createTable(spec: CreateTableBody): Promise<void> {
    const defs = spec.columns.map((col) => columnDdl("mysql", col));
    const pk = spec.columns.filter((col) => col.primaryKey).map((col) => quoteIdent("mysql", col.name));
    if (pk.length > 0) defs.push(`PRIMARY KEY (${pk.join(", ")})`);
    for (const col of spec.columns) if (col.unique && !col.primaryKey) defs.push(`UNIQUE (${quoteIdent("mysql", col.name)})`);
    await this.#run((c) => c.query(`CREATE TABLE ${this.#q(spec.name)} (\n  ${defs.join(",\n  ")}\n)`));
  }

  async renameTable(table: string, name: string): Promise<void> {
    await this.#run((c) => c.query(`RENAME TABLE ${this.#q(table)} TO ${this.#q(name)}`));
  }

  async dropTable(table: string): Promise<void> {
    await this.#run(async (c) => {
      const detail = await this.#describe(c, table);
      await c.query(`DROP ${detail.tableType === "view" ? "VIEW" : "TABLE"} ${this.#q(table)}`);
    });
  }

  async truncateTable(table: string): Promise<void> {
    await this.#run((c) => c.query(`TRUNCATE TABLE ${this.#q(table)}`));
  }

  async addColumn(table: string, spec: AddColumnBody): Promise<void> {
    const after = spec.after ? ` AFTER ${quoteIdent("mysql", spec.after)}` : "";
    await this.#run((c) => c.query(`ALTER TABLE ${this.#q(table)} ADD COLUMN ${columnDdl("mysql", spec.column)}${after}`));
  }

  async modifyColumn(table: string, column: string, spec: ColumnSpec): Promise<void> {
    await this.#run((c) => c.query(`ALTER TABLE ${this.#q(table)} CHANGE COLUMN ${quoteIdent("mysql", column)} ${columnDdl("mysql", spec)}`));
  }

  async dropColumn(table: string, column: string): Promise<void> {
    await this.#run((c) => c.query(`ALTER TABLE ${this.#q(table)} DROP COLUMN ${quoteIdent("mysql", column)}`));
  }

  async addIndex(table: string, spec: IndexSpec): Promise<void> {
    const cols = spec.columns.map((n) => quoteIdent("mysql", n)).join(", ");
    await this.#run((c) => c.query(`CREATE ${spec.unique ? "UNIQUE " : ""}INDEX ${quoteIdent("mysql", spec.name)} ON ${this.#q(table)} (${cols})`));
  }

  async dropIndex(table: string, index: string): Promise<void> {
    await this.#run((c) => c.query(`ALTER TABLE ${this.#q(table)} DROP INDEX ${quoteIdent("mysql", index)}`));
  }

  // --- dump ------------------------------------------------------------------

  async createTableSql(table: string): Promise<string> {
    return this.#run(async (c) => {
      const [rows] = (await c.query(`SHOW CREATE TABLE ${this.#q(table)}`)) as [Row[], unknown];
      const row = rows[0];
      const sql = row?.["Create Table"] ?? row?.["Create View"];
      if (!sql) throw new DbQueryError(`table "${table}" does not exist`);
      return `${String(sql)};`;
    });
  }

  async *streamRows(table: string, columns: string[]): AsyncIterable<unknown[][]> {
    let c: Connection | undefined;
    try {
      c = await createConnection({
        host: this.target.host,
        port: this.target.port,
        user: this.target.username,
        password: this.target.password,
        database: this.#db(),
        connectTimeout: CONNECT_TIMEOUT_MS,
        supportBigNumbers: true,
        bigNumberStrings: false,
        dateStrings: true,
        jsonStrings: true,
      });
    } catch (error) {
      throw toDbError(error, "connect");
    }
    try {
      const cols = columns.map((n) => quoteIdent("mysql", n)).join(", ");
      // The promise wrapper keeps the callback connection underneath; only
      // that one can stream rows instead of collecting them.
      const raw = (c as unknown as { connection: CallbackConnection }).connection;
      const stream = raw.query({ sql: `SELECT ${cols} FROM ${this.#q(table)}`, rowsAsArray: true }).stream();
      let batch: unknown[][] = [];
      for await (const row of stream as AsyncIterable<unknown[]>) {
        batch.push(row);
        if (batch.length >= BATCH) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    } catch (error) {
      throw toDbError(error, "query");
    } finally {
      c.destroy();
    }
  }

  literal(value: unknown, column: ColumnInfo): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (typeof value === "boolean") return value ? "1" : "0";
    if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
    if (value instanceof Date) return quoteLiteral("mysql", value.toISOString().slice(0, 19).replace("T", " "));
    if (typeof value === "string" && column.kind === "number" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return value;
    return quoteLiteral("mysql", typeof value === "string" ? value : JSON.stringify(value));
  }

  async importCsv(table: string, header: string[], rows: string[][], opts: CsvImportOpts): Promise<{ inserted: number }> {
    return this.#run(
      async (c) => {
        const detail = await this.#describe(c, table);
        requireColumns(detail, header, "header");
        const cols = header.map((n) => quoteIdent("mysql", n)).join(", ");
        const tuple = `(${header.map(() => "?").join(", ")})`;
        let inserted = 0;
        await c.query("START TRANSACTION");
        try {
          for (let i = 0; i < rows.length; i += BATCH) {
            const slice = rows.slice(i, i + BATCH);
            const params = slice.flatMap((row) => header.map((_, j) => csvValue(row[j], opts)));
            const [result] = (await c.query(
              `INSERT INTO ${this.#q(table)} (${cols}) VALUES ${slice.map(() => tuple).join(", ")}`,
              params,
            )) as [ResultSetHeader, unknown];
            inserted += result.affectedRows;
          }
          await c.query("COMMIT");
        } catch (error) {
          await c.query("ROLLBACK").catch(() => {});
          throw error;
        }
        return { inserted };
      },
      { timeoutMs: 0 },
      0,
    );
  }

  // --- users -----------------------------------------------------------------

  async listUsers(): Promise<DbUser[]> {
    return this.#run(async (c) => {
      const db = this.#db();
      const [[accounts], [schema], [global]] = await Promise.all([
        c.query("SELECT User AS name, Host AS host, account_locked = 'Y' AS locked FROM mysql.user ORDER BY User, Host"),
        c.query("SELECT GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege FROM information_schema.SCHEMA_PRIVILEGES WHERE TABLE_SCHEMA = ?", [db]),
        c.query("SELECT GRANTEE AS grantee, PRIVILEGE_TYPE AS privilege FROM information_schema.USER_PRIVILEGES"),
      ]);
      const byGrantee = (rows: Row[]) => {
        const map = new Map<string, string[]>();
        for (const row of rows) {
          const key = String(row.grantee);
          map.set(key, [...(map.get(key) ?? []), String(row.privilege)]);
        }
        return map;
      };
      const onDb = byGrantee(schema as Row[]);
      const everywhere = byGrantee(global as Row[]);
      return (accounts as Row[]).map((row) => {
        const grantee = `'${row.name}'@'${row.host}'`;
        return {
          name: String(row.name),
          host: String(row.host),
          privileges: onDb.get(grantee) ?? [],
          global: (everywhere.get(grantee) ?? []).filter((p) => p !== "USAGE"),
          flags: { locked: Boolean(Number(row.locked)) },
        };
      });
    });
  }

  async createUser(name: string, password: string, host = "%"): Promise<void> {
    await this.#run((c) => c.query(`CREATE USER ${mysqlAccount(name, host)} IDENTIFIED BY ${quoteLiteral("mysql", password)}`));
  }

  async dropUser(name: string, host = "%"): Promise<void> {
    await this.#run((c) => c.query(`DROP USER ${mysqlAccount(name, host)}`));
  }

  async grant(spec: GrantSpec): Promise<void> {
    const list = privilegeList(spec.privileges);
    await this.#run((c) => c.query(`GRANT ${list} ON ${quoteIdent("mysql", this.#db())}.* TO ${mysqlAccount(spec.name, spec.host ?? "%")}`));
  }

  async revoke(spec: GrantSpec): Promise<void> {
    const list = privilegeList(spec.privileges);
    await this.#run((c) => c.query(`REVOKE ${list} ON ${quoteIdent("mysql", this.#db())}.* FROM ${mysqlAccount(spec.name, spec.host ?? "%")}`));
  }
}

function privilegeList(privileges: string[]): string {
  const allowed = new Set<string>(MYSQL_PRIVILEGES);
  const upper = privileges.map((p) => p.toUpperCase().replace(/\s+/g, " ").trim());
  for (const p of upper) if (!allowed.has(p)) throw new DbQueryError(`unknown privilege "${p}"`);
  return upper.includes("ALL") ? "ALL PRIVILEGES" : upper.join(", ");
}

export function csvValue(raw: string | undefined, opts: CsvImportOpts): string | null {
  if (raw === undefined || raw === "\\N") return null;
  if (raw === "" && opts.emptyAsNull) return null;
  return raw;
}
