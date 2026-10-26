import type { DbAdapter, DbTarget } from "./adapter.js";
import { MysqlAdapter } from "./mysql.js";
import { PostgresAdapter } from "./postgres.js";

export function adapterFor(target: DbTarget, db: string | null): DbAdapter {
  return target.engine === "mysql" ? new MysqlAdapter(target, db) : new PostgresAdapter(target, db);
}

export type { DbAdapter, DbTarget } from "./adapter.js";
export { DbConnectError, DbQueryError, DbRefusal, RowConflictError } from "./adapter.js";
