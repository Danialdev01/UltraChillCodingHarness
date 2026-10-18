import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Applies pending migrations.
 *
 * Called on server boot so a fresh deployment comes up with a schema rather
 * than failing on the first query. Drizzle records applied migrations in a
 * metadata table, so this is idempotent and safe to run on every start.
 *
 * A dedicated single-use connection is opened and closed here: migrations run
 * before the application pool exists, and holding a pool open across DDL is a
 * good way to deadlock against your own queries.
 */
export async function runMigrations(url: string): Promise<void> {
  // Beside the sources by default; a bundled server, which has no sources
  // beside it, names the folder it shipped instead.
  const folder = process.env.MIGRATIONS_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: folder });
  } finally {
    await sql.end();
  }
}
