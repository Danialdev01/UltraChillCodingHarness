import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const sql = postgres(url, { max: 1 });

await migrate(drizzle(sql), { migrationsFolder: join(here, "..", "migrations") });
await sql.end();
console.log("migrations applied");
