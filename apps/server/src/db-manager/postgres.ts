import postgres, { type Sql, type TransactionSql } from "postgres";
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
import { PG_PRIVILEGES } from "@ucch/protocol";
import {
  DbQueryError,
  DbRefusal,
  guardedColumns,
  preview,
  requireColumns,
  requireKey,
  RowConflictError,
  toDbError,
  withDeadline,
  type ConnOpts,
  type CsvImportOpts,
  type DbAdapter,
  type DbTarget,
  type GrantSpec,
  type SqlRunOpts,
} from "./adapter.js";
import { columnDdl, defaultSql } from "./ddl.js";
import { csvValue } from "./mysql.js";
import { bindValue, cellKindFor, serializeCell } from "./serialize.js";
import { escapeLike, qualified, quoteIdent, quoteLiteral } from "./sql-ident.js";
import { splitStatements } from "./sql-split.js";

const CONNECT_TIMEOUT_S = 5;
const DEFAULT_STATEMENT_MS = 60_000;
const DEADLINE_MS = 90_000;
const MAX_DATABASES = 500;
const COUNT_LIMIT = 500_000;
const BATCH = 500;
/** PostgreSQL binds at most 65535 parameters per statement. */
const MAX_PARAMS = 30_000;
const SCHEMA = "public";

type Row = Record<string, unknown>;
type Db = Sql | TransactionSql;

const FK_ACTIONS: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

/**
 * One PostgreSQL session for one job.
 *
 * A session is bound to one database, so the database is chosen here and
 * cannot change afterwards; the maintenance database stands in when none
 * was named. Dates are left as the text the server sent: JSON has no date,
 * and the grid shows what `psql` would.
 */
export async function withPostgres<T>(
  target: DbTarget,
  database: string | null,
  fn: (sql: Sql) => Promise<T>,
  opts: ConnOpts = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? DEFAULT_STATEMENT_MS;
  const sql = postgres({
    host: target.host,
    port: target.port,
    username: target.username,
    password: target.password,
    database: database || target.database || "postgres",
    connect_timeout: CONNECT_TIMEOUT_S,
    max: 1,
    ssl: "prefer",
    onnotice: () => {},
    connection: { application_name: "ucch", ...(timeout > 0 ? { statement_timeout: timeout } : {}) },
    types: {
      date: { to: 1184, from: [1082, 1114, 1184], serialize: (x: string) => x, parse: (x: string) => x },
    },
  });
  try {
    await sql`select 1`;
  } catch (error) {
    await sql.end({ timeout: 0 }).catch(() => {});
    throw toDbError(error, "connect");
  }
  try {
    return await fn(sql);
  } catch (error) {
    throw toDbError(error, "query");
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

export class PostgresAdapter implements DbAdapter {
  readonly engine = "postgresql" as const;

  constructor(
    private readonly target: DbTarget,
    private readonly db: string | null,
  ) {}

  #run<T>(fn: (sql: Sql) => Promise<T>, opts: ConnOpts = {}, deadline = DEADLINE_MS): Promise<T> {
    return withDeadline(withPostgres(this.target, this.db, fn, opts), deadline);
  }

  #db(): string {
    if (!this.db) throw new DbRefusal("no database selected");
    return this.db;
  }

  #q(table: string): string {
    return qualified("postgresql", this.#db(), table);
  }

  async ping(): Promise<void> {
    await this.#run(async () => undefined, {}, 10_000);
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.#run(
      (sql) => sql.unsafe("select datname from pg_database where datistemplate = false order by datname"),
      {},
      10_000,
    );
    return rows.map((row) => String(row.datname)).slice(0, MAX_DATABASES);
  }

  async describeDatabases(): Promise<DatabaseSummary[]> {
    // The size is asked for only where CONNECT is held; elsewhere the call
    // itself would raise and take the whole list with it.
    const rows = await this.#run(
      (sql) =>
        sql.unsafe(
          `select datname, case when has_database_privilege(datname, 'CONNECT') then pg_database_size(datname) end as size
           from pg_database where datistemplate = false order by datname`,
        ),
      {},
      10_000,
    );
    return rows
      .map((row) => ({ name: String(row.datname), sizeBytes: row.size === null ? null : Number(row.size), tables: null }))
      .slice(0, MAX_DATABASES);
  }

  async createDatabase(name: string): Promise<void> {
    await this.#run((sql) => sql.unsafe(`create database ${quoteIdent("postgresql", name)}`), {}, 30_000);
  }

  async dropDatabase(name: string): Promise<void> {
    await this.#run((sql) => sql.unsafe(`drop database ${quoteIdent("postgresql", name)}`), {}, 60_000);
  }

  async listTables(): Promise<TableSummary[]> {
    const rows = await this.#run((sql) =>
      sql.unsafe(
        `select c.relname as name,
                case when c.relkind in ('v', 'm') then 'view' else 'table' end as "tableType",
                greatest(c.reltuples, 0)::bigint as "rowEstimate",
                pg_total_relation_size(c.oid) as "sizeBytes",
                obj_description(c.oid, 'pg_class') as comment
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') order by c.relname`,
        [SCHEMA],
      ),
    );
    return rows.map((row) => {
      const view = row.tableType === "view";
      return {
        name: String(row.name),
        tableType: view ? "view" : "table",
        rowEstimate: view ? null : Number(row.rowEstimate),
        sizeBytes: view ? null : Number(row.sizeBytes),
        comment: row.comment ? String(row.comment) : null,
      };
    });
  }

  async describeTable(table: string): Promise<TableDetail> {
    return this.#run((sql) => this.#describe(sql, table));
  }

  async #oid(sql: Db, table: string): Promise<{ oid: number; view: boolean }> {
    const rows = await sql.unsafe(
      `select c.oid, c.relkind in ('v', 'm') as view from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm')`,
      [SCHEMA, table],
    );
    const row = rows[0];
    if (!row) throw new DbQueryError(`table "${table}" does not exist`, "42P01");
    return { oid: Number(row.oid), view: Boolean(row.view) };
  }

  async #describe(sql: Db, table: string): Promise<TableDetail> {
    const { oid, view } = await this.#oid(sql, table);
    const [columnRows, constraintRows, indexRows] = await Promise.all([
      sql.unsafe(
        `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, t.typname as "dataType",
                not a.attnotnull as nullable, pg_get_expr(d.adbin, d.adrelid) as "defaultValue",
                (a.attidentity <> '' or coalesce(pg_get_expr(d.adbin, d.adrelid), '') like 'nextval(%') as autoincrement,
                a.attgenerated <> '' as generated, col_description(a.attrelid, a.attnum) as comment
         from pg_attribute a join pg_type t on t.oid = a.atttypid
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`,
        [oid],
      ),
      sql.unsafe(
        `select con.conname as name, con.contype, pg_get_constraintdef(con.oid) as definition,
                (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns,
                cr.relname as "refTable",
                (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as "refColumns",
                con.confupdtype as "onUpdate", con.confdeltype as "onDelete"
         from pg_constraint con left join pg_class cr on cr.oid = con.confrelid
         where con.conrelid = $1 and con.contype in ('p', 'u', 'f') order by con.contype, con.conname`,
        [oid],
      ),
      sql.unsafe(
        `select i.relname as name, ix.indisunique as "isUnique", ix.indisprimary as "isPrimary", am.amname as type,
                (select array_agg(a.attname order by k.ord) from unnest(ix.indkey) with ordinality k(attnum, ord)
                   join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = k.attnum) as columns
         from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_am am on am.oid = i.relam
         where ix.indrelid = $1 order by i.relname`,
        [oid],
      ),
    ]);

    const primaryKey: string[] = [];
    const uniqueSingles = new Set<string>();
    const foreignKeys: ForeignKeyInfo[] = [];
    for (const row of constraintRows as Row[]) {
      const columns = (row.columns as string[] | null) ?? [];
      if (row.contype === "p") primaryKey.push(...columns);
      else if (row.contype === "u" && columns.length === 1) uniqueSingles.add(columns[0]!);
      else if (row.contype === "f") {
        foreignKeys.push({
          name: String(row.name),
          columns,
          refTable: String(row.refTable),
          refColumns: (row.refColumns as string[] | null) ?? [],
          onUpdate: FK_ACTIONS[String(row.onUpdate)] ?? String(row.onUpdate),
          onDelete: FK_ACTIONS[String(row.onDelete)] ?? String(row.onDelete),
        });
      }
    }

    const columns: ColumnInfo[] = (columnRows as Row[]).map((row) => ({
      name: String(row.name),
      type: String(row.type),
      dataType: String(row.dataType),
      kind: cellKindFor("postgresql", String(row.dataType), String(row.type)),
      nullable: Boolean(row.nullable),
      default: row.defaultValue === null ? null : String(row.defaultValue),
      primary: primaryKey.includes(String(row.name)),
      unique: uniqueSingles.has(String(row.name)),
      autoincrement: Boolean(row.autoincrement),
      generated: Boolean(row.generated),
      comment: row.comment ? String(row.comment) : null,
    }));

    const indexes: IndexInfo[] = (indexRows as Row[]).map((row) => ({
      name: String(row.name),
      columns: ((row.columns as (string | null)[] | null) ?? []).map((c) => c ?? "(expression)"),
      unique: Boolean(row.isUnique),
      primary: Boolean(row.isPrimary),
      type: row.type ? String(row.type) : null,
    }));

    return { name: table, tableType: view ? "view" : "table", columns, primaryKey, indexes, foreignKeys };
  }

  async browse(table: string, query: RowsQuery): Promise<RowPage> {
    return this.#run(async (sql) => {
      const detail = await this.#describe(sql, table);
      if (query.sort) requireColumns(detail, [query.sort], "sort");

      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.where?.trim()) clauses.push(`(${query.where})`);
      if (query.q?.trim()) {
        const searchable = detail.columns.filter((col) => col.kind !== "bytes");
        params.push(`%${escapeLike(query.q.trim())}%`);
        clauses.push(`(${searchable.map((col) => `${quoteIdent("postgresql", col.name)}::text ilike $${params.length}`).join(" OR ")})`);
      }
      const where = clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "";
      const order = query.sort ? ` order by ${quoteIdent("postgresql", query.sort)} ${query.dir === "desc" ? "desc" : "asc"}` : "";
      const offset = (query.page - 1) * query.pageSize;

      const rows = await sql
        .unsafe(`select * from ${this.#q(table)}${where}${order} limit $${params.length + 1} offset $${params.length + 2}`, [
          ...params,
          query.pageSize,
          offset,
        ] as never[])
        .values();

      let total: number;
      let exact = true;
      const estimate = clauses.length === 0 ? await this.#estimate(sql, table) : null;
      if (estimate !== null && estimate > COUNT_LIMIT) {
        total = estimate;
        exact = false;
      } else {
        const count = await sql.unsafe(`select count(*)::int as n from ${this.#q(table)}${where}`, params as never[]);
        total = Number(count[0]?.n ?? 0);
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

  async #estimate(sql: Db, table: string): Promise<number | null> {
    const rows = await sql.unsafe(
      `select greatest(c.reltuples, 0)::bigint as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relname = $2`,
      [SCHEMA, table],
    );
    return rows[0] ? Number(rows[0].n) : null;
  }

  async insertRow(table: string, values: Record<string, Cell>): Promise<{ row?: Cell[]; insertId?: string }> {
    return this.#run(async (sql) => {
      const detail = await this.#describe(sql, table);
      const names = Object.keys(values);
      requireColumns(detail, names, "values");
      const text =
        names.length === 0
          ? `insert into ${this.#q(table)} default values returning *`
          : `insert into ${this.#q(table)} (${names.map((n) => quoteIdent("postgresql", n)).join(", ")}) values (${names
              .map((_, i) => `$${i + 1}`)
              .join(", ")}) returning *`;
      const rows = await sql.unsafe(text, names.map((n) => bindValue(values[n]!)) as never[]).values();
      const row = (rows as unknown[][])[0];
      return row ? { row: row.map(serializeCell) } : {};
    });
  }

  async updateRow(
    table: string,
    key: Record<string, Cell>,
    values: Record<string, Cell>,
    original: Record<string, Cell> = {},
  ): Promise<void> {
    await this.#run(async (sql) => {
      const detail = await this.#describe(sql, table);
      const pk = requireKey(detail, key);
      const names = Object.keys(values);
      requireColumns(detail, names, "values");
      if (names.length === 0) return;
      const guarded = guardedColumns(detail, original);
      const params: unknown[] = [];
      const bind = (cell: Cell) => `$${params.push(bindValue(cell))}`;
      const sets = names.map((n) => `${quoteIdent("postgresql", n)} = ${bind(values[n]!)}`);
      const keyed = pk.map((n) => `${quoteIdent("postgresql", n)} is not distinct from ${bind(key[n]!)}`);
      const unchanged = guarded.map((n) => `${quoteIdent("postgresql", n)} is not distinct from ${bind(original[n]!)}`);
      const result = await sql.unsafe(
        `update ${this.#q(table)} set ${sets.join(", ")} where ${[...keyed, ...unchanged].join(" and ")}`,
        params as never[],
      );
      if (result.count === 1) return;
      if (result.count > 1) throw new DbQueryError("key matched more than one row");
      // Nothing matched: the row is gone, or one of its cells moved on.
      const current = guarded.length
        ? await sql
            .unsafe(`select * from ${this.#q(table)} where ${pk.map((n, i) => `${quoteIdent("postgresql", n)} is not distinct from $${i + 1}`).join(" and ")}`, pk.map((n) => bindValue(key[n]!)) as never[])
            .values()
        : [];
      if (current[0]) throw new RowConflictError((current[0] as unknown[]).map(serializeCell));
      throw new DbQueryError("row not found");
    });
  }

  async deleteRows(table: string, keys: Record<string, Cell>[]): Promise<{ affected: number }> {
    return this.#run(async (sql) => {
      const detail = await this.#describe(sql, table);
      const pk = requireKey(detail, keys[0] ?? {});
      const params: unknown[] = [];
      const clauses = keys.map((key) => {
        requireKey(detail, key);
        return `(${pk
          .map((n) => {
            params.push(bindValue(key[n]!));
            return `${quoteIdent("postgresql", n)} is not distinct from $${params.length}`;
          })
          .join(" and ")})`;
      });
      const result = await sql.unsafe(`delete from ${this.#q(table)} where ${clauses.join(" or ")}`, params as never[]);
      return { affected: result.count };
    });
  }

  async runSql(text: string, opts: SqlRunOpts): Promise<StatementResult[]> {
    const statements = splitStatements(text, "postgresql");
    return this.#run(
      async (sql) => {
        const results: StatementResult[] = [];
        for (const statement of statements) {
          const started = performance.now();
          try {
            const result = await sql.unsafe(statement).values();
            const durationMs = Math.round(performance.now() - started);
            const columns = result.columns as { name: string }[] | undefined;
            if (columns && columns.length > 0) {
              const all = result as unknown as unknown[][];
              results.push({
                statement: preview(statement),
                durationMs,
                columns: columns.map((c) => c.name),
                rows: all.slice(0, opts.maxRows).map((row) => row.map(serializeCell)),
                ...(all.length > opts.maxRows ? { truncated: true } : {}),
                command: result.command,
              });
            } else {
              results.push({ statement: preview(statement), durationMs, affectedRows: result.count ?? 0, command: result.command });
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
    const defs = spec.columns.map((col) => columnDdl("postgresql", col));
    const pk = spec.columns.filter((col) => col.primaryKey).map((col) => quoteIdent("postgresql", col.name));
    if (pk.length > 0) defs.push(`primary key (${pk.join(", ")})`);
    for (const col of spec.columns) if (col.unique && !col.primaryKey) defs.push(`unique (${quoteIdent("postgresql", col.name)})`);
    await this.#run((sql) =>
      sql.begin(async (tx) => {
        await tx.unsafe(`create table ${this.#q(spec.name)} (\n  ${defs.join(",\n  ")}\n)`);
        for (const col of spec.columns) {
          if (col.comment) await tx.unsafe(`comment on column ${this.#q(spec.name)}.${quoteIdent("postgresql", col.name)} is ${quoteLiteral("postgresql", col.comment)}`);
        }
      }),
    );
  }

  async renameTable(table: string, name: string): Promise<void> {
    await this.#run((sql) => sql.unsafe(`alter table ${this.#q(table)} rename to ${quoteIdent("postgresql", name)}`));
  }

  async dropTable(table: string): Promise<void> {
    await this.#run(async (sql) => {
      const { view } = await this.#oid(sql, table);
      await sql.unsafe(`drop ${view ? "view" : "table"} ${this.#q(table)}`);
    });
  }

  async truncateTable(table: string): Promise<void> {
    await this.#run((sql) => sql.unsafe(`truncate table ${this.#q(table)}`));
  }

  async addColumn(table: string, spec: AddColumnBody): Promise<void> {
    await this.#run((sql) =>
      sql.begin(async (tx) => {
        await tx.unsafe(`alter table ${this.#q(table)} add column ${columnDdl("postgresql", spec.column)}`);
        if (spec.column.comment) {
          await tx.unsafe(`comment on column ${this.#q(table)}.${quoteIdent("postgresql", spec.column.name)} is ${quoteLiteral("postgresql", spec.column.comment)}`);
        }
      }),
    );
  }

  async modifyColumn(table: string, column: string, spec: ColumnSpec): Promise<void> {
    const t = this.#q(table);
    const old = quoteIdent("postgresql", column);
    await this.#run((sql) =>
      sql.begin(async (tx) => {
        await tx.unsafe(`alter table ${t} alter column ${old} type ${spec.type}`);
        await tx.unsafe(`alter table ${t} alter column ${old} ${spec.nullable && !spec.primaryKey ? "drop" : "set"} not null`);
        if (spec.default) await tx.unsafe(`alter table ${t} alter column ${old} set default ${defaultSql("postgresql", spec.default)}`);
        else await tx.unsafe(`alter table ${t} alter column ${old} drop default`);
        if (spec.comment !== undefined) {
          await tx.unsafe(`comment on column ${t}.${old} is ${spec.comment ? quoteLiteral("postgresql", spec.comment) : "null"}`);
        }
        if (spec.name !== column) await tx.unsafe(`alter table ${t} rename column ${old} to ${quoteIdent("postgresql", spec.name)}`);
      }),
    );
  }

  async dropColumn(table: string, column: string): Promise<void> {
    await this.#run((sql) => sql.unsafe(`alter table ${this.#q(table)} drop column ${quoteIdent("postgresql", column)}`));
  }

  async addIndex(table: string, spec: IndexSpec): Promise<void> {
    const cols = spec.columns.map((n) => quoteIdent("postgresql", n)).join(", ");
    await this.#run((sql) => sql.unsafe(`create ${spec.unique ? "unique " : ""}index ${quoteIdent("postgresql", spec.name)} on ${this.#q(table)} (${cols})`));
  }

  async dropIndex(_table: string, index: string): Promise<void> {
    await this.#run((sql) => sql.unsafe(`drop index ${quoteIdent("postgresql", SCHEMA)}.${quoteIdent("postgresql", index)}`));
  }

  // --- dump ------------------------------------------------------------------

  /**
   * CREATE TABLE as reconstructed from the catalog. Constraints come out
   * exactly (`pg_get_constraintdef`); table options and partitioning do not
   * come out at all, which a phpMyAdmin-style dump can live with.
   */
  async createTableSql(table: string): Promise<string> {
    return this.#run(async (sql) => {
      const { oid, view } = await this.#oid(sql, table);
      const t = this.#q(table);
      if (view) {
        // `::oid`, or the driver's text parameter picks the (text, bool)
        // overload and the number is looked up as a relation *name*.
        const rows = await sql.unsafe("select pg_get_viewdef($1::oid, true) as def", [oid]);
        return `CREATE VIEW ${t} AS\n${String(rows[0]?.def ?? "").trim().replace(/;$/, "")};`;
      }
      const detail = await this.#describe(sql, table);
      const lines: string[] = [];
      const sequences = new Set<string>();
      for (const col of detail.columns) {
        const parts = [quoteIdent("postgresql", col.name), col.type];
        if (!col.nullable) parts.push("NOT NULL");
        // An identity column has no default expression; its counter is its own.
        if (col.autoincrement && !col.default) parts.push("GENERATED BY DEFAULT AS IDENTITY");
        if (col.default && !col.generated) {
          parts.push(`DEFAULT ${col.default}`);
          const seq = /nextval\('([^']+)'/.exec(col.default);
          if (seq) sequences.add(seq[1]!);
        }
        lines.push(parts.join(" "));
      }
      const constraints = await sql.unsafe(
        "select conname as name, pg_get_constraintdef(oid) as def, contype from pg_constraint where conrelid = $1 and contype in ('p', 'u', 'c') order by contype, conname",
        [oid],
      );
      for (const row of constraints) lines.push(`CONSTRAINT ${quoteIdent("postgresql", String(row.name))} ${row.def}`);
      const out: string[] = [];
      for (const seq of sequences) out.push(`CREATE SEQUENCE IF NOT EXISTS ${seq};`);
      out.push(`CREATE TABLE ${t} (\n  ${lines.join(",\n  ")}\n);`);
      const indexes = await sql.unsafe(
        "select pg_get_indexdef(ix.indexrelid) as def from pg_index ix where ix.indrelid = $1 and not exists (select 1 from pg_constraint where conindid = ix.indexrelid)",
        [oid],
      );
      for (const row of indexes) out.push(`${row.def};`);
      for (const col of detail.columns) {
        if (col.comment) out.push(`COMMENT ON COLUMN ${t}.${quoteIdent("postgresql", col.name)} IS ${quoteLiteral("postgresql", col.comment)};`);
      }
      return out.join("\n");
    });
  }

  /** The FK constraints of a table, for a dump's tail. */
  async foreignKeySql(table: string): Promise<string[]> {
    return this.#run(async (sql) => {
      const { oid } = await this.#oid(sql, table);
      const rows = await sql.unsafe("select conname as name, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1 and contype = 'f'", [oid]);
      return rows.map((row) => `ALTER TABLE ${this.#q(table)} ADD CONSTRAINT ${quoteIdent("postgresql", String(row.name))} ${row.def};`);
    });
  }

  async *streamRows(table: string, columns: string[]): AsyncIterable<unknown[][]> {
    const sql = postgres({
      host: this.target.host,
      port: this.target.port,
      username: this.target.username,
      password: this.target.password,
      database: this.#db(),
      connect_timeout: CONNECT_TIMEOUT_S,
      max: 1,
      ssl: "prefer",
      onnotice: () => {},
      types: { date: { to: 1184, from: [1082, 1114, 1184], serialize: (x: string) => x, parse: (x: string) => x } },
    });
    try {
      const cols = columns.map((n) => quoteIdent("postgresql", n)).join(", ");
      const cursor = sql.unsafe(`select ${cols} from ${this.#q(table)}`).values().cursor(BATCH);
      for await (const batch of cursor) yield batch as unknown as unknown[][];
    } catch (error) {
      throw toDbError(error, "query");
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {});
    }
  }

  literal(value: unknown, column: ColumnInfo): string {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    if (Buffer.isBuffer(value)) return `'\\x${value.toString("hex")}'`;
    if (value instanceof Date) return quoteLiteral("postgresql", value.toISOString());
    if (typeof value === "string" && column.kind === "number" && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value)) return value;
    if (typeof value === "string") return quoteLiteral("postgresql", value);
    if (Array.isArray(value) && column.type.endsWith("[]")) return quoteLiteral("postgresql", pgArray(value));
    return quoteLiteral("postgresql", JSON.stringify(value));
  }

  async importCsv(table: string, header: string[], rows: string[][], opts: CsvImportOpts): Promise<{ inserted: number }> {
    return this.#run(
      async (sql) => {
        const detail = await this.#describe(sql, table);
        requireColumns(detail, header, "header");
        const cols = header.map((n) => quoteIdent("postgresql", n)).join(", ");
        const batch = Math.max(1, Math.min(BATCH, Math.floor(MAX_PARAMS / header.length)));
        let inserted = 0;
        await sql.begin(async (tx) => {
          for (let i = 0; i < rows.length; i += batch) {
            const slice = rows.slice(i, i + batch);
            const params: unknown[] = [];
            const tuples = slice.map(
              (row) =>
                `(${header
                  .map((_, j) => {
                    params.push(csvValue(row[j], opts));
                    return `$${params.length}`;
                  })
                  .join(", ")})`,
            );
            const result = await tx.unsafe(`insert into ${this.#q(table)} (${cols}) values ${tuples.join(", ")}`, params as never[]);
            inserted += result.count;
          }
        });
        return { inserted };
      },
      { timeoutMs: 0 },
      0,
    );
  }

  // --- users -----------------------------------------------------------------

  async listUsers(): Promise<DbUser[]> {
    return this.#run(async (sql) => {
      const db = this.#db();
      const [roles, grants, tables] = await Promise.all([
        sql.unsafe(
          `select r.rolname as name, r.rolcanlogin as "canLogin", r.rolsuper as superuser, r.rolcreatedb as "createDb",
                  r.rolcreaterole as "createRole",
                  has_database_privilege(r.oid, $1, 'CONNECT') as connect, has_database_privilege(r.oid, $1, 'CREATE') as "createInDb"
           from pg_roles r where r.rolname not like 'pg\\_%' order by r.rolname`,
          [db],
        ),
        sql.unsafe(
          `select g.rolname as name, a.privilege_type as privilege, count(*)::int as tables
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
           join pg_roles g on g.oid = a.grantee
           where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm') group by 1, 2`,
          [SCHEMA],
        ),
        sql.unsafe("select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm')", [SCHEMA]),
      ]);
      const total = Number(tables[0]?.n ?? 0);
      const byRole = new Map<string, string[]>();
      for (const row of grants) {
        const name = String(row.name);
        const count = Number(row.tables);
        const label = total > 0 && count < total ? `${row.privilege} (${count}/${total})` : String(row.privilege);
        byRole.set(name, [...(byRole.get(name) ?? []), label]);
      }
      return roles.map((row) => ({
        name: String(row.name),
        host: null,
        privileges: byRole.get(String(row.name)) ?? [],
        global: [],
        flags: {
          login: Boolean(row.canLogin),
          superuser: Boolean(row.superuser),
          createDb: Boolean(row.createDb),
          createRole: Boolean(row.createRole),
          connect: Boolean(row.connect),
          create: Boolean(row.createInDb),
        },
      }));
    });
  }

  async createUser(name: string, password: string): Promise<void> {
    await this.#run((sql) => sql.unsafe(`create role ${quoteIdent("postgresql", name)} login password ${quoteLiteral("postgresql", password)}`));
  }

  async dropUser(name: string, _host?: string, force = false): Promise<void> {
    const role = quoteIdent("postgresql", name);
    await this.#run((sql) =>
      sql.begin(async (tx) => {
        if (force) {
          await tx.unsafe(`reassign owned by ${role} to current_user`);
          await tx.unsafe(`drop owned by ${role}`);
        }
        await tx.unsafe(`drop role ${role}`);
      }),
    );
  }

  async grant(spec: GrantSpec): Promise<void> {
    const list = privilegeList(spec.privileges);
    const role = quoteIdent("postgresql", spec.name);
    const db = quoteIdent("postgresql", this.#db());
    const writes = /\b(INSERT|UPDATE|ALL)\b/.test(list);
    await this.#run((sql) =>
      sql.begin(async (tx) => {
        await tx.unsafe(`grant connect on database ${db} to ${role}`);
        await tx.unsafe(`grant usage on schema ${SCHEMA} to ${role}`);
        await tx.unsafe(`grant ${list} on all tables in schema ${SCHEMA} to ${role}`);
        if (writes) await tx.unsafe(`grant usage, select on all sequences in schema ${SCHEMA} to ${role}`);
        await tx.unsafe(`alter default privileges in schema ${SCHEMA} grant ${list} on tables to ${role}`);
      }),
    );
  }

  async revoke(spec: GrantSpec): Promise<void> {
    const list = privilegeList(spec.privileges);
    const role = quoteIdent("postgresql", spec.name);
    const db = quoteIdent("postgresql", this.#db());
    await this.#run((sql) =>
      sql.begin(async (tx) => {
        await tx.unsafe(`revoke ${list} on all tables in schema ${SCHEMA} from ${role}`);
        await tx.unsafe(`alter default privileges in schema ${SCHEMA} revoke ${list} on tables from ${role}`);
        if (spec.connect === false) await tx.unsafe(`revoke connect on database ${db} from ${role}`);
      }),
    );
  }
}

function privilegeList(privileges: string[]): string {
  const allowed = new Set<string>(PG_PRIVILEGES);
  const upper = privileges.map((p) => p.toUpperCase().trim());
  for (const p of upper) if (!allowed.has(p)) throw new DbQueryError(`unknown privilege "${p}"`);
  return upper.includes("ALL") ? "ALL PRIVILEGES" : upper.join(", ");
}

function pgArray(values: unknown[]): string {
  return `{${values
    .map((v) => (v === null ? "NULL" : Array.isArray(v) ? pgArray(v) : `"${String(v).replace(/(["\\])/g, "\\$1")}"`))
    .join(",")}}`;
}
