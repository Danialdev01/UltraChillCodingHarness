import { drizzle } from "drizzle-orm/postgres-js";
import { DrizzleQueryError } from "drizzle-orm";
import { PgPreparedQuery } from "drizzle-orm/pg-core";
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

/**
 * Drizzle wraps a failed query's error in one whose message lists every
 * parameter -- password hashes and tokens among them -- which a log line, an
 * event or a reply would then carry; and it hides the driver's `code`, which
 * is how a unique conflict is told from a failure. The driver's own error is
 * thrown instead, as it was before drizzle 0.44.
 */
interface Cached {
  queryWithCache(query: string, params: unknown[], run: () => Promise<unknown>): Promise<unknown>;
}
const prepared = PgPreparedQuery.prototype as unknown as Cached;
const queryWithCache = prepared.queryWithCache;
prepared.queryWithCache = async function (this: Cached, ...args) {
  try {
    return await queryWithCache.apply(this, args);
  } catch (error) {
    throw error instanceof DrizzleQueryError && error.cause ? error.cause : error;
  }
};

export function createDatabase(url: string, { max = DEFAULT_POOL_MAX }: PoolOptions = {}) {
  const sql = postgres(url, { ...POOL, max });
  return drizzle(sql, { schema });
}
