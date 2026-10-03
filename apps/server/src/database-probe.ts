import { adapterFor } from "./db-manager/index.js";
import type { DbTarget } from "./db-manager/adapter.js";

/**
 * Opening a user's MySQL or PostgreSQL server and asking it one question.
 *
 * A thin face over the database manager's adapters, kept so the connection
 * routes read as they always did: test the credentials, list what is there.
 */
export type ProbeTarget = DbTarget;
export { DbConnectError as ProbeError } from "./db-manager/adapter.js";

/** Connects, runs a trivial query, and disconnects. Throws `ProbeError` on any failure. */
export function probe(target: ProbeTarget): Promise<void> {
  return adapterFor(target, null).ping();
}
