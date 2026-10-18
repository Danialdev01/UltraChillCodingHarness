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
  // A queue of directories drained by a fixed number of workers, rather than
  // one awaited stat at a time: a project with `node_modules` is a hundred
  // thousand entries, and walking them in series took seconds per project.
  const queue = [dir];
  let total = 0;
  let active = 0;

  await new Promise<void>((done) => {
    const pump = () => {
      while (active < WALK_CONCURRENCY && queue.length > 0) {
        const next = queue.pop()!;
        active++;
        void visit(next).finally(() => {
          active--;
          if (queue.length === 0 && active === 0) done();
          else pump();
        });
      }
      if (queue.length === 0 && active === 0) done();
    };

    const visit = async (path: string) => {
      let entries;
      try {
        entries = await readdir(path, { withFileTypes: true });
      } catch {
        return;
      }
      const files: string[] = [];
      for (const entry of entries) {
        const child = join(path, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(child);
        else files.push(child);
      }
      const sizes = await Promise.all(
        // Gone between readdir and stat: nothing to count.
        files.map((file) => lstat(file).then((info) => info.size, () => 0)),
      );
      for (const size of sizes) total += size;
    };

    pump();
  });
  return total;
}

/** Directories read at once by `directoryBytes`. */
const WALK_CONCURRENCY = 16;

/**
 * How long a project's measured size is reused.
 *
 * The Usage tab is opened, reloaded and opened again; the answer moves by
 * the size of an edit in that time, and measuring it is a walk of every file.
 */
const SIZE_TTL_MS = 5 * 60_000;

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
    if (!(await this.workspaces.canView(workspaceId, userId))) return null;

    const rows = await this.db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId));

    const [projectSizes, tables] = await Promise.all([
      Promise.all(rows.map(async (row) => ({ ...row, bytes: await this.projectBytes(row.id) }))),
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

  /**
   * One project's directory, for its manage page. Ownership is the caller's
   * check. Reused for `SIZE_TTL_MS`, and concurrent asks share one walk.
   */
  projectBytes(projectId: string, now = Date.now()): Promise<number> {
    const cached = this.#sizes.get(projectId);
    if (cached && now - cached.at < SIZE_TTL_MS) return cached.bytes;

    const bytes = directoryBytes(join(this.workspaceRoot, projectId));
    this.#sizes.set(projectId, { at: now, bytes });
    // A failed walk is not remembered.
    bytes.catch(() => this.#sizes.delete(projectId));
    return bytes;
  }

  #sizes = new Map<string, { at: number; bytes: Promise<number> }>();

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
