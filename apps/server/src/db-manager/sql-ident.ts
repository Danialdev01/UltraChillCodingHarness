import { escape as mysqlEscape } from "mysql2";
import type { DatabaseEngine } from "@ucch/protocol";

/**
 * Quoting for the SQL this module writes itself.
 *
 * Every name that reaches an engine goes through `quoteIdent`, whether it
 * passed the strict `Identifier` schema or the loose `ExistingName` one:
 * the schema decides what may be created, the quoting is what makes any
 * name safe to reference. Data never comes through here -- it is bound as
 * a parameter -- so `quoteLiteral` is only for the few statements that
 * cannot take one (DDL defaults, passwords in CREATE USER).
 */
export function quoteIdent(engine: DatabaseEngine, name: string): string {
  return engine === "mysql" ? `\`${name.replace(/`/g, "``")}\`` : `"${name.replace(/"/g, '""')}"`;
}

export function quoteLiteral(engine: DatabaseEngine, value: string): string {
  // postgres-js sessions run with standard_conforming_strings on, so a
  // doubled quote is the only escape. mysql2 knows MySQL's own rules.
  return engine === "mysql" ? mysqlEscape(value) : `'${value.replace(/'/g, "''")}'`;
}

/** `db`.`table` on MySQL; "public"."table" on PostgreSQL, whose database is the session's. */
export function qualified(engine: DatabaseEngine, db: string, table: string): string {
  return engine === "mysql"
    ? `${quoteIdent(engine, db)}.${quoteIdent(engine, table)}`
    : `${quoteIdent(engine, "public")}.${quoteIdent(engine, table)}`;
}

/** A MySQL account reference: 'user'@'host'. */
export function mysqlAccount(name: string, host: string): string {
  return `${mysqlEscape(name)}@${mysqlEscape(host)}`;
}

/** Escapes LIKE's own wildcards so a search for "50%" finds "50%". */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
