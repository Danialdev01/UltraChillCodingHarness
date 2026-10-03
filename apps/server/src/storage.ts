import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { projects, type Database } from "@ucch/db";
import type { WorkspaceService } from "./workspaces.js";

/** One project's directory under the workspace root, in bytes. */
export interface ProjectStorage {
  id: string;
  name: string;
  bytes: number;
}

/** One Postgres table, in bytes including its indexes and TOAST. */
export interface TableStorage {
  name: string;
  bytes: number;
}

/**
 * What a workspace occupies on disk and in the database.
 *
 * The file figures are the workspace's own: one row per project directory.
 * The database ones are the whole instance, because rows are not
 * partitioned by workspace and the reader who is asking "how big is the
 * database" wants the number the volume shows rather than a share guessed
 * from row counts.
 */
export interface WorkspaceStorage {
  files: { bytes: number; projects: ProjectStorage[] };
  database: { bytes: number; tables: TableStorage[] };
}

/**
 * The size of everything under `dir`, in bytes, as `du -sb` would count it.
 *
 * Symlinks count for the link itself and are never followed: one pointing
 * out of the tree would bill the workspace for the host, and a cycle would
 * not terminate. `node_modules` is included on purpose -- it is the bulk of
 * what a project occupies, and hiding it is how a disk fills up unexplained.
 * A directory that vanishes mid-walk counts as empty rather than failing the
 * whole report.
 */
export async function directoryBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      total += await directoryBytes(path);
      continue;
    }
    try {
      total += (await lstat(path)).size;
    } catch {
      // Gone between readdir and stat; nothing to count.
    }
  }
  return total;
}

export class StorageService {
  constructor(
    private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Disk and database usage for the Usage tab, or null for a workspace the
   * user does not own.
   *
   * Project directories are walked in parallel; they are independent trees
   * and a workspace of ten projects should not take ten times as long as
   * one. Largest first, which is the order the card reads them in.
   */
  async forWorkspace(workspaceId: string, userId: string): Promise<WorkspaceStorage | null> {
    if (!(await this.workspaces.ownedBy(workspaceId, userId))) return null;

    const rows = await this.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId));

    const [projectSizes, tables] = await Promise.all([
      Promise.all(
        rows.map(async (row) => ({
          ...row,
          bytes: await directoryBytes(join(this.workspaceRoot, row.id)),
        })),
      ),
      this.tableSizes(),
    ]);
    projectSizes.sort((a, b) => b.bytes - a.bytes);

    return {
      files: {
        bytes: projectSizes.reduce((sum, row) => sum + row.bytes, 0),
        projects: projectSizes,
      },
      database: {
        bytes: await this.databaseBytes(),
        tables,
      },
    };
  }

  /** The database as Postgres measures it: every relation, index and TOAST. */
  private async databaseBytes(): Promise<number> {
    const result = await this.db.execute<{ bytes: string }>(
      sql`select pg_database_size(current_database())::text as bytes`,
    );
    return Number(result[0]?.bytes ?? 0);
  }

  /**
   * Each table in the public schema with its indexes and TOAST, largest
   * first. Drizzle's migration bookkeeping lives in its own schema and is
   * not listed; it is a fact about the tool, not about the data.
   */
  private async tableSizes(): Promise<TableStorage[]> {
    const result = await this.db.execute<{ name: string; bytes: string }>(sql`
      select relname as name,
             pg_total_relation_size(c.oid)::text as bytes
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by pg_total_relation_size(c.oid) desc
    `);
    return result.map((row) => ({ name: row.name, bytes: Number(row.bytes) }));
  }
}
