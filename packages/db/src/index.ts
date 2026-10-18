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

/**
 * Pool settings shared by both clients. Idle connections are closed after a
 * minute and every connection is recycled after half an hour, so a quiet
 * server does not hold Postgres slots it is not using and a connection never
 * outlives a failover or a proxy's own idle cut-off by much.
 */
const POOL = { max: 10, idle_timeout: 60, max_lifetime: 30 * 60, onnotice: () => {} } as const;

export function createDatabase(url: string) {
  const sql = postgres(url, POOL);
  return drizzle(sql, { schema });
}

export function createClient(url: string) {
  return postgres(url, POOL);
}
