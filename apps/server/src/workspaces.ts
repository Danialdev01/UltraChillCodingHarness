import { and, asc, eq, getTableName, inArray, sql, type Column, type SQL } from "drizzle-orm";
import { previews, projects, threads, turns, workspaces, type Database } from "@ucch/db";

/**
 * A column spelled out with its table, for correlated sub-selects inside a
 * single-table `select`.
 *
 * Drizzle sees no join on the outer query and rewrites every column it finds
 * in a `sql` field to its bare name, so `${projects.id}` inside `from
 * threads` comes out as `"id"` -- which Postgres rejects as ambiguous,
 * because `threads` has one too. A raw identifier is left alone.
 */
function qualified(column: Column): SQL {
  return sql.raw(`"${getTableName(column.table)}"."${column.name}"`);
}

export interface ProjectSummary {
  id: string;
  hash: string;
  name: string;
  stack: string;
  containerState: string;
  /** The port the owner's dev server listens on; null until set. */
  previewPort: number | null;
  workspaceId?: string;
}

/**
 * A project as the Code and Dashboard tables show it.
 *
 * The extra columns over `ProjectSummary` are the ones a table has room for
 * and a sidebar row does not -- where the code came from, and when it was
 * last touched, which is what the list is sorted by.
 */
export interface ProjectRow extends ProjectSummary {
  /** Null for a project that was started rather than cloned. */
  repoUrl: string | null;
  defaultBranch: string;
  lastActiveAt: Date;
  createdAt: Date;
  /** Whether a turn is in flight in any of this project's threads. */
  running: boolean;
  threadCount: number;
  /** Every token this project's turns have been billed for, all kinds summed. */
  tokens: number;
  costUsd: number;
}

/**
 * The Dashboard's headline numbers for one workspace.
 *
 * Assembled server-side because every one of them is an aggregate over rows
 * the browser is not allowed to see. `todo` has no source yet -- there is no
 * todos table until the agent core lands -- and says so rather than being
 * filled with a plausible zero.
 */
export interface WorkspaceStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  costUsd: number;
  turnCount: number;
  projects: { total: number; running: number; containersUp: number };
  previews: { total: number; live: number; expiringSoon: number };
  /** Null until there is somewhere for tasks to live. */
  todo: { due: number; open: number } | null;
}

/** One model's share of a workspace's bill. */
export interface ModelUsage {
  /** The provider's id, or null for turns recorded before it was stored. */
  model: string | null;
  costUsd: number;
  requests: number;
  tokens: number;
}

/**
 * Spend, requests and tokens for a workspace, split by model.
 *
 * The whole list comes back rather than a pre-cut "top three plus others":
 * the three largest by spend are not the three largest by requests -- a
 * cheap model answering constantly inverts the order -- so each card has to
 * rank the same rows for itself.
 */
export interface WorkspaceUsage {
  totals: { costUsd: number; requests: number; tokens: number };
  models: ModelUsage[];
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  projectCount: number;
}

/**
 * Workspaces are organisation, not project activity, so they live outside the
 * event log alongside users and sessions and are served over REST. See the
 * scope note at the top of `packages/protocol/src/events.ts`.
 */
export class WorkspaceService {
  constructor(private readonly db: Database) {}

  async list(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.db
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        name: workspaces.name,
        projectCount: sql<number>`count(${projects.id})::int`,
      })
      .from(workspaces)
      .leftJoin(projects, eq(projects.workspaceId, workspaces.id))
      .where(eq(workspaces.ownerUserId, userId))
      .groupBy(workspaces.id)
      .orderBy(asc(workspaces.createdAt));

    return rows;
  }

  async create(userId: string, name: string): Promise<WorkspaceSummary | { conflict: true }> {
    const trimmed = name.trim();
    const slug = await this.#uniqueSlug(userId, trimmed);
    if (!slug) return { conflict: true };

    const [row] = await this.db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: trimmed, slug })
      .returning();

    return { id: row!.id, slug: row!.slug, name: row!.name, projectCount: 0 };
  }

  /**
   * A project by its public hash, scoped to the caller.
   *
   * The ownership check is part of the query rather than a second lookup, so
   * a hash belonging to someone else is indistinguishable from one that does
   * not exist.
   */
  async findByHash(hash: string, userId: string): Promise<ProjectSummary | null> {
    const [row] = await this.db
      .select({
        id: projects.id,
        hash: projects.hash,
        name: projects.name,
        stack: projects.stack,
        containerState: projects.containerState,
        previewPort: projects.previewPort,
        workspaceId: projects.workspaceId,
      })
      .from(projects)
      .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
      .where(and(eq(projects.hash, hash), eq(workspaces.ownerUserId, userId)))
      .limit(1);

    return row ?? null;
  }

  /**
   * Projects in a workspace, for the sidebar and the project tables.
   * Ownership is checked first.
   *
   * The thread counts come from correlated sub-selects rather than a join and
   * a group-by: a project with no threads still has to appear, and a left
   * join here would need the aggregate anyway to avoid multiplying the row.
   *
   * Ordered by name, which is what the sidebar reads; the tables re-sort in
   * the browser, where the reader can change their mind.
   */
  async listProjects(workspaceId: string, userId: string): Promise<ProjectRow[] | null> {
    if (!(await this.ownedBy(workspaceId, userId))) return null;

    return this.db
      .select({
        id: projects.id,
        hash: projects.hash,
        name: projects.name,
        stack: projects.stack,
        containerState: projects.containerState,
        previewPort: projects.previewPort,
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        lastActiveAt: projects.lastActiveAt,
        createdAt: projects.createdAt,
        running: sql<boolean>`exists (
          select 1 from ${threads}
          where ${threads.projectId} = ${qualified(projects.id)} and ${threads.status} = 'running'
        )`,
        threadCount: sql<number>`(
          select count(*)::int from ${threads} where ${threads.projectId} = ${qualified(projects.id)}
        )`,
        // The same sums `stats` makes for the workspace, per project. The
        // cast to double precision is for the same reason: a bigint arrives
        // as a string, and the table would sort those as text.
        tokens: sql<number>`(
          select coalesce(sum(
            (${turns.usage} ->> 'inputTokens')::double precision
            + (${turns.usage} ->> 'outputTokens')::double precision
            + (${turns.usage} ->> 'cacheReadInputTokens')::double precision
            + (${turns.usage} ->> 'cacheCreationInputTokens')::double precision
          ), 0)
          from ${turns} join ${threads} on ${turns.threadId} = ${qualified(threads.id)}
          where ${threads.projectId} = ${qualified(projects.id)}
        )`,
        costUsd: sql<number>`(
          select coalesce(sum(${turns.costUsd})::double precision, 0)
          from ${turns} join ${threads} on ${turns.threadId} = ${qualified(threads.id)}
          where ${threads.projectId} = ${qualified(projects.id)}
        )`,
      })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId))
      .orderBy(asc(projects.name))
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          tokens: Number(row.tokens ?? 0),
          costUsd: Number(row.costUsd ?? 0),
        })),
      );
  }

  /**
   * The Dashboard's numbers, in three queries rather than one.
   *
   * Token totals, project states and preview states aggregate over different
   * tables at different grains; folding them into a single statement would
   * need either a cross join or three sub-selects on a scalar row, and both
   * read worse than three named queries that each say what they count.
   *
   * Sums are cast to `double precision` so they arrive as numbers -- a
   * `bigint` comes back from the driver as a string, which would then be
   * concatenated rather than added the first time anyone totalled two of
   * them.
   */
  async stats(workspaceId: string, userId: string): Promise<WorkspaceStats | null> {
    if (!(await this.ownedBy(workspaceId, userId))) return null;

    const usage = (key: string) =>
      sql<number>`coalesce(sum((${turns.usage} ->> ${key})::double precision), 0)`;

    const [tokenRow] = await this.db
      .select({
        input: usage("inputTokens"),
        output: usage("outputTokens"),
        cacheRead: usage("cacheReadInputTokens"),
        cacheWrite: usage("cacheCreationInputTokens"),
        costUsd: sql<number>`coalesce(sum(${turns.costUsd})::double precision, 0)`,
        turnCount: sql<number>`count(*)::int`,
      })
      .from(turns)
      .innerJoin(threads, eq(turns.threadId, threads.id))
      .innerJoin(projects, eq(threads.projectId, projects.id))
      .where(eq(projects.workspaceId, workspaceId));

    const [projectRow] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        running: sql<number>`count(*) filter (where exists (
          select 1 from ${threads}
          where ${threads.projectId} = ${qualified(projects.id)} and ${threads.status} = 'running'
        ))::int`,
        containersUp: sql<number>`count(*) filter (
          where ${projects.containerState} = 'running'
        )::int`,
      })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId));

    const [previewRow] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        live: sql<number>`count(*) filter (
          where ${previews.containerState} = 'running' and ${previews.expiresAt} > now()
        )::int`,
        // The ones worth acting on today: still up, but not for much longer.
        expiringSoon: sql<number>`count(*) filter (
          where ${previews.expiresAt} > now() and ${previews.expiresAt} < now() + interval '24 hours'
        )::int`,
      })
      .from(previews)
      .innerJoin(projects, eq(previews.projectId, projects.id))
      .where(eq(projects.workspaceId, workspaceId));

    const tokens = {
      input: Number(tokenRow?.input ?? 0),
      output: Number(tokenRow?.output ?? 0),
      cacheRead: Number(tokenRow?.cacheRead ?? 0),
      cacheWrite: Number(tokenRow?.cacheWrite ?? 0),
    };

    return {
      tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
      costUsd: Number(tokenRow?.costUsd ?? 0),
      turnCount: Number(tokenRow?.turnCount ?? 0),
      projects: {
        total: Number(projectRow?.total ?? 0),
        running: Number(projectRow?.running ?? 0),
        containersUp: Number(projectRow?.containersUp ?? 0),
      },
      previews: {
        total: Number(previewRow?.total ?? 0),
        live: Number(previewRow?.live ?? 0),
        expiringSoon: Number(previewRow?.expiringSoon ?? 0),
      },
      // No todos table exists yet, so there is nothing to count. Null rather
      // than zero: "none due" and "the feature has not landed" are different
      // things, and the card says which one it is showing.
      todo: null,
    };
  }

  /**
   * The same bill as `stats`, broken down by the model that ran the turn.
   *
   * Turns with no usage recorded still count as requests: a turn that failed
   * or was cancelled cost something at the provider even when nothing came
   * back to total, and dropping it would make the request count disagree
   * with the thread history the reader can see.
   */
  async usage(workspaceId: string, userId: string): Promise<WorkspaceUsage | null> {
    if (!(await this.ownedBy(workspaceId, userId))) return null;

    const usage = (key: string) =>
      sql<number>`coalesce(sum((${turns.usage} ->> ${key})::double precision), 0)`;

    const rows = await this.db
      .select({
        model: turns.model,
        costUsd: sql<number>`coalesce(sum(${turns.costUsd})::double precision, 0)`,
        requests: sql<number>`count(*)::int`,
        tokens: sql<number>`${usage("inputTokens")} + ${usage("outputTokens")}
          + ${usage("cacheReadInputTokens")} + ${usage("cacheCreationInputTokens")}`,
      })
      .from(turns)
      .innerJoin(threads, eq(turns.threadId, threads.id))
      .innerJoin(projects, eq(threads.projectId, projects.id))
      .where(eq(projects.workspaceId, workspaceId))
      .groupBy(turns.model);

    const models = rows
      .map((row) => ({
        model: row.model,
        costUsd: Number(row.costUsd ?? 0),
        requests: Number(row.requests ?? 0),
        tokens: Number(row.tokens ?? 0),
      }))
      // Descending spend is the order the list is stored in; the cards that
      // rank by something else sort their own copy.
      .sort((a, b) => b.costUsd - a.costUsd);

    return {
      totals: {
        costUsd: models.reduce((sum, row) => sum + row.costUsd, 0),
        requests: models.reduce((sum, row) => sum + row.requests, 0),
        tokens: models.reduce((sum, row) => sum + row.tokens, 0),
      },
      models,
    };
  }

  /**
   * Removes a project, and with it everything the log holds for it.
   *
   * Deletion is REST rather than a command for the same reason creating a
   * workspace is: it is organisation, not project activity. It also could
   * not be event-sourced without contradiction -- `events.project_id` is a
   * foreign key onto the row being removed, so the event recording the
   * deletion would be deleted by the deletion it records. Threads, turns,
   * events and sub-agents all cascade from this one statement.
   *
   * A thread mid-turn is refused rather than deleted out from under the
   * reactor: the loop would go on appending events for a project that no
   * longer exists and fail on the foreign key instead of finishing. Stopping
   * the turn first is one click, and `agent.turn_completed` releases it.
   */
  /**
   * Records the port the owner's dev server listens on, or clears it. Goes
   * through `findByHash`, so somebody else's hash is refused the same way a
   * missing one is.
   */
  async setPreviewPort(
    hash: string,
    userId: string,
    port: number | null,
  ): Promise<ProjectSummary | null> {
    const project = await this.findByHash(hash, userId);
    if (!project) return null;
    await this.db.update(projects).set({ previewPort: port }).where(eq(projects.id, project.id));
    return { ...project, previewPort: port };
  }

  /**
   * What the preview proxy needs to serve a subdomain, by hash alone. Not
   * user-scoped: by the time a request reaches the proxy the visitor's
   * authorization is in the preview cookie, which names the project it was
   * issued for; this only says which port that project has claimed.
   */
  async previewTarget(
    hash: string,
  ): Promise<{ id: string; userId: string; previewPort: number | null } | null> {
    const [row] = await this.db
      .select({ id: projects.id, userId: projects.userId, previewPort: projects.previewPort })
      .from(projects)
      .where(eq(projects.hash, hash))
      .limit(1);
    return row ?? null;
  }

  async deleteProject(
    hash: string,
    userId: string,
  ): Promise<{ projectId: string } | { error: "not_found" | "busy" }> {
    // Through `findByHash`, so a hash belonging to somebody else is refused
    // by the same predicate that refuses one that does not exist.
    const project = await this.findByHash(hash, userId);
    if (!project) return { error: "not_found" };

    const [busy] = await this.db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(eq(threads.projectId, project.id), inArray(threads.status, ["running", "cancelling"])),
      )
      .limit(1);
    if (busy) return { error: "busy" };

    await this.db.delete(projects).where(eq(projects.id, project.id));
    return { projectId: project.id };
  }

  /**
   * Confirms the workspace exists AND belongs to this user -- both conditions
   * in one predicate. Checking them separately would let any user who owns
   * some workspace pass the check for somebody else's.
   */
  async ownedBy(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, userId)))
      .limit(1);
    return Boolean(row);
  }

  /**
   * The first workspace for a new account. Named after the person rather than
   * left blank, so the switcher has something meaningful in it on first load.
   */
  async ensureDefault(userId: string, name = "Personal"): Promise<WorkspaceSummary> {
    const existing = await this.list(userId);
    if (existing.length > 0) return existing[0]!;

    const created = await this.create(userId, name);
    if ("conflict" in created) {
      // Another boot won the race; whichever landed first is fine.
      return (await this.list(userId))[0]!;
    }
    return created;
  }

  /**
   * Slugs are unique per owner, so a second "Acme" becomes "acme-2". Gives up
   * after a bounded number of attempts rather than looping forever.
   */
  async #uniqueSlug(userId: string, name: string): Promise<string | null> {
    const base = slugify(name);
    const taken = new Set((await this.list(userId)).map((w) => w.slug));

    if (!taken.has(base)) return base;
    for (let i = 2; i <= 50; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return null;
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // A name of only punctuation or non-Latin script would slugify to nothing.
  return slug || "workspace";
}
