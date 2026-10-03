import type { TableDetail } from "@ucch/protocol";
import type { DbAdapter } from "./adapter.js";
import { csvRow } from "./csv.js";
import type { PostgresAdapter } from "./postgres.js";
import { qualified, quoteIdent } from "./sql-ident.js";

export interface DumpOptions {
  create: boolean;
  data: boolean;
  drop: boolean;
}

const INSERT_BATCH = 500;

/**
 * A SQL dump, yielded in pieces as the rows stream in.
 *
 * Foreign keys go last on PostgreSQL so table order does not matter on
 * the way back in; MySQL gets the same effect from FOREIGN_KEY_CHECKS=0.
 * Views are created after tables for the same reason.
 */
export async function* sqlDump(adapter: DbAdapter, db: string, tables: TableDetail[], opts: DumpOptions): AsyncGenerator<string> {
  const mysql = adapter.engine === "mysql";
  yield `-- ${mysql ? "MySQL" : "PostgreSQL"} dump of ${db}\n-- ${new Date().toISOString()}\n\n`;
  yield mysql ? "SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n" : "SET client_encoding = 'UTF8';\n\n";

  const ordered = [...tables].sort((a, b) => Number(a.tableType === "view") - Number(b.tableType === "view"));
  for (const table of ordered) {
    const name = qualified(adapter.engine, db, table.name);
    yield `--\n-- ${table.tableType === "view" ? "View" : "Table"} ${table.name}\n--\n\n`;
    if (opts.drop) yield `DROP ${table.tableType === "view" ? "VIEW" : "TABLE"} IF EXISTS ${name};\n`;
    if (opts.create) yield `${await adapter.createTableSql(table.name)}\n\n`;
    if (opts.data && table.tableType === "table") {
      const columns = table.columns.filter((col) => !col.generated);
      const names = columns.map((col) => quoteIdent(adapter.engine, col.name)).join(", ");
      let count = 0;
      for await (const batch of adapter.streamRows(table.name, columns.map((col) => col.name))) {
        for (let i = 0; i < batch.length; i += INSERT_BATCH) {
          const slice = batch.slice(i, i + INSERT_BATCH);
          const values = slice.map((row) => `(${row.map((value, j) => adapter.literal(value, columns[j]!)).join(", ")})`);
          yield `INSERT INTO ${name} (${names}) VALUES\n${values.join(",\n")};\n`;
          count += slice.length;
        }
      }
      if (count > 0) yield "\n";
      // Explicit ids leave the counter behind; move it past them so the
      // next insert does not collide with a row just restored.
      if (!mysql && count > 0) {
        for (const col of columns.filter((c) => c.autoincrement)) {
          const id = quoteIdent(adapter.engine, col.name);
          yield `SELECT setval(pg_get_serial_sequence('${name.replace(/'/g, "''")}', '${col.name.replace(/'/g, "''")}'), COALESCE(MAX(${id}), 1), MAX(${id}) IS NOT NULL) FROM ${name};\n\n`;
        }
      }
    }
  }

  if (opts.create && !mysql) {
    const pg = adapter as PostgresAdapter;
    for (const table of tables) {
      if (table.tableType !== "table" || table.foreignKeys.length === 0) continue;
      for (const line of await pg.foreignKeySql(table.name)) yield `${line}\n`;
    }
    yield "\n";
  }
  if (mysql) yield "SET FOREIGN_KEY_CHECKS = 1;\n";
}

export async function* csvDump(adapter: DbAdapter, table: TableDetail): AsyncGenerator<string> {
  const columns = table.columns;
  yield csvRow(columns.map((col) => col.name));
  for await (const batch of adapter.streamRows(table.name, columns.map((col) => col.name))) {
    yield batch.map((row) => csvRow(row.map(csvCell))).join("");
  }
}

function csvCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
