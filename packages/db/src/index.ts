import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";
export { schema };
export { runMigrations } from "./bootstrap.js";

export type Database = ReturnType<typeof createDatabase>;

/**
 * The transaction handle passed to `db.transaction(...)`. Exported so callers
 * can type projection callbacks without re-deriving it through conditional
 * types at every use site.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export function createDatabase(url: string) {
  // `max: 1` is deliberate for the command worker's connection: commands are
  // serialized through a single fiber, so a pool would only add ways for two
  // decisions to interleave. Read paths get their own pooled client.
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return drizzle(sql, { schema });
}

export function createClient(url: string) {
  return postgres(url, { max: 10, onnotice: () => {} });
}
