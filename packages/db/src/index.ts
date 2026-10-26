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
const POOL = { idle_timeout: 60, max_lifetime: 30 * 60, onnotice: () => {} } as const;

/** Connections a client opens unless told otherwise (the server's `DB_POOL_MAX`). */
export const DEFAULT_POOL_MAX = 20;

export interface PoolOptions {
  /** Connections this client may open: what anything running queries side by side must stay under. */
  max?: number;
}

export function createDatabase(url: string, { max = DEFAULT_POOL_MAX }: PoolOptions = {}) {
  const sql = postgres(url, { ...POOL, max });
  return drizzle(sql, { schema });
}

export function createClient(url: string, { max = DEFAULT_POOL_MAX }: PoolOptions = {}) {
  return postgres(url, { ...POOL, max });
}
