import { randomBytes } from "node:crypto";
import { and, asc, eq, getTableName, inArray, sql, type Column, type SQL } from "drizzle-orm";
import {
  previews,
  projects,
  threads,
  turns,
  users,
  workspaceMembers,
  workspaces,
  type Database,
} from "@ucch/db";
import {
  can,
  CredentialPolicy,
  generateHash,
  LIMIT_STOP_REASONS,
  permissionsOf,
  WorkspaceRole,
  type Membership,
  type WorkspacePermission,
} from "@ucch/protocol";

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
  /** The working-tree folder a static preview is served from; null for a dev server. */
  previewStaticDir: string | null;
  workspaceId?: string;
  /** The project's workspace address and kind, so a client can build its URL. */
  workspaceHash?: string;
  workspaceKind?: WorkspaceKind;
  /** The caller's standing in the project's workspace, when resolved for a caller. */
  membership?: Membership;
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
  /**
   * Whether the project's latest turn failed or was cut off by a limit, as
   * `stoppedShort` in @ucch/protocol judges a stop reason -- the sidebar's
   * red dot, so it is still there after a reload.
   */
  failed: boolean;
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

/** One project's share of the bill, for its manage page. */
export interface ProjectUsage {
  tokens: WorkspaceStats["tokens"];
  costUsd: number;
  turnCount: number;
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

export type WorkspaceKind = "project" | "session";

export interface WorkspaceSummary {
  id: string;
  slug: string;
  /** The workspace's address in the web app, `/{hash}`. */
  hash: string;
  name: string;
  /** What the workspace holds: named projects, or quick sessions. */
  kind: WorkspaceKind;
  archived: boolean;
  projectCount: number;
  /** A `data:image/...` URL, or null for the default icon. */
  logo: string | null;
  /** The caller's role here, and what it lets them do. */
  role: WorkspaceRole;
  permissions: WorkspacePermission[];
  /** True when somebody else owns it and the caller is a member. */
  shared: boolean;
  ownerName: string;
  credentialPolicy: CredentialPolicy;
}

/** A membership row read back with the person it belongs to. */
export interface MemberRow extends Membership {
  userId: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  joinedAt: Date;
}

/** Narrows the stored text columns to the enums; anything unknown reads as the least access. */
export function toMembership(row: {
  role: string;
  canCreateProject: boolean | null;
  canCreateSession: boolean | null;
}): Membership {
  const role = WorkspaceRole.safeParse(row.role);
  return {
    role: role.success ? role.data : "viewer",
    canCreateProject: row.canCreateProject,
    canCreateSession: row.canCreateSession,
  };
}

export function toPolicy(value: string): CredentialPolicy {
  const parsed = CredentialPolicy.safeParse(value);
  return parsed.success ? parsed.data : "member";
}

/**
 * Workspaces are organisation, not project activity, so they live outside the
 * event log alongside users and sessions and are served over REST. See the
 * scope note at the top of `packages/protocol/src/events.ts`.
 */
export class WorkspaceService {
  constructor(private readonly db: Database) {}

  /** Every workspace the caller is a member of, their own and shared ones alike. */
  async list(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.db
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        hash: workspaces.hash,
        name: workspaces.name,
        kind: workspaces.kind,
        archivedAt: workspaces.archivedAt,
        logo: workspaces.logo,
        ownerUserId: workspaces.ownerUserId,
        credentialPolicy: workspaces.credentialPolicy,
        role: workspaceMembers.role,
        canCreateProject: workspaceMembers.canCreateProject,
        canCreateSession: workspaceMembers.canCreateSession,
        ownerName: sql<string>`coalesce(${users.name}, ${users.login})`,
        projectCount: sql<number>`(select count(*)::int from ${projects} where ${projects.workspaceId} = ${workspaces.id})`,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .innerJoin(users, eq(users.id, workspaces.ownerUserId))
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(asc(workspaces.createdAt));

    return rows.map(
      ({ archivedAt, kind, ownerUserId, credentialPolicy, role, canCreateProject, canCreateSession, ...row }) => {
        const membership = toMembership({ role, canCreateProject, canCreateSession });
        return {
          ...row,
          kind: kind === "session" ? "session" : "project",
          archived: archivedAt !== null,
          role: membership.role,
          permissions: permissionsOf(membership),
          shared: ownerUserId !== userId,
          credentialPolicy: toPolicy(credentialPolicy),
        };
      },
    );
  }

  async create(
    userId: string,
    name: string,
    kind: WorkspaceKind = "project",
  ): Promise<WorkspaceSummary | { conflict: true }> {
    const trimmed = name.trim();
    const slug = await this.#uniqueSlug(userId, trimmed);
    if (!slug) return { conflict: true };
    const hash = await this.#uniqueHash();

    const row = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(workspaces)
        .values({ ownerUserId: userId, name: trimmed, slug, hash, kind })
        .returning();
      await tx.insert(workspaceMembers).values({ workspaceId: created!.id, userId, role: "owner" });
      return created!;
    });

    return (await this.list(userId)).find((w) => w.id === row.id)!;
  }

  /**
   * Renames, archives and sets the logo of a workspace. The slug stays put: it is an
   * identifier, and a rename should not move anything that points at it.
   */
  async update(
    workspaceId: string,
    userId: string,
    patch: { name?: string; archived?: boolean; logo?: string | null },
  ): Promise<WorkspaceSummary | null> {
    if (!can(await this.membership(workspaceId, userId), "workspace.manage")) return null;

    const set: { name?: string; archivedAt?: Date | null; logo?: string | null } = {};
    if (patch.logo !== undefined) set.logo = patch.logo;
    if (patch.name !== undefined) set.name = patch.name.trim();
    if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
    if (Object.keys(set).length > 0) {
      await this.db.update(workspaces).set(set).where(eq(workspaces.id, workspaceId));
    }
    return (await this.list(userId)).find((w) => w.id === workspaceId) ?? null;
  }

  /**
   * Removes a workspace, but only an empty one.
   *
   * Projects would cascade with it, and a workspace's projects are the
   * expensive part to lose -- so one that still has any is archived instead,
   * and this refuses it rather than trusting the menu to have hidden the
   * option.
   */
  async deleteWorkspace(
    workspaceId: string,
    userId: string,
  ): Promise<{ ok: true } | { error: "not_found" | "forbidden" | "not_empty" }> {
    const workspace = (await this.list(userId)).find((w) => w.id === workspaceId);
    if (!workspace) return { error: "not_found" };
    if (!workspace.permissions.includes("workspace.delete")) return { error: "forbidden" };
    if (workspace.projectCount > 0) return { error: "not_empty" };

    await this.db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    return { ok: true };
  }

  /** A workspace by its URL hash, or null when the caller is not a member of it. */
  async findWorkspaceByHash(hash: string, userId: string): Promise<WorkspaceSummary | null> {
    const [row] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.hash, hash))
      .limit(1);
    if (!row) return null;
    return (await this.list(userId)).find((w) => w.id === row.id) ?? null;
  }

  /** Renames a project, through `findByHash` so only a member can. */
  async renameProject(hash: string, userId: string, name: string): Promise<ProjectSummary | null> {
    const project = await this.findByHash(hash, userId);
    if (!project) return null;
    const trimmed = name.trim();
    await this.db.update(projects).set({ name: trimmed }).where(eq(projects.id, project.id));
    return { ...project, name: trimmed };
  }

  /**
   * A project by its public hash, scoped to the caller.
   *
   * The membership check is part of the query rather than a second lookup, so
   * a hash in a workspace the caller is not in is indistinguishable from one
   * that does not exist. The membership comes back with it, for the routes
   * that also need to know what the caller may do.
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
        previewStaticDir: projects.previewStaticDir,
        workspaceId: projects.workspaceId,
        workspaceHash: workspaces.hash,
        workspaceKind: workspaces.kind,
        role: workspaceMembers.role,
        canCreateProject: workspaceMembers.canCreateProject,
        canCreateSession: workspaceMembers.canCreateSession,
      })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .innerJoin(
        workspaceMembers,
        and(eq(workspaceMembers.workspaceId, projects.workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .where(eq(projects.hash, hash))
      .limit(1);
    if (!row) return null;

    const { role, canCreateProject, canCreateSession, workspaceKind, ...project } = row;
    return {
      ...project,
      workspaceKind: workspaceKind === "session" ? "session" : "project",
      membership: toMembership({ role, canCreateProject, canCreateSession }),
    };
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
    if (!(await this.canView(workspaceId, userId))) return null;

    return this.db
      .select({
        id: projects.id,
        hash: projects.hash,
        name: projects.name,
        stack: projects.stack,
        containerState: projects.containerState,
        previewPort: projects.previewPort,
        previewStaticDir: projects.previewStaticDir,
        workspaceId: projects.workspaceId,
        workspaceHash: workspaces.hash,
        workspaceKind: workspaces.kind,
        repoUrl: projects.repoUrl,
        defaultBranch: projects.defaultBranch,
        lastActiveAt: projects.lastActiveAt,
        createdAt: projects.createdAt,
        running: sql<boolean>`exists (
          select 1 from ${threads}
          where ${threads.projectId} = ${qualified(projects.id)} and ${threads.status} = 'running'
        )`,
        failed: sql<boolean>`coalesce((
          select ${qualified(turns.error)} is not null
            or ${qualified(turns.stopReason)} in (${sql.join([...LIMIT_STOP_REASONS].map((r) => sql`${r}`), sql`, `)})
            or ${qualified(turns.stopReason)} like 'error%'
          from ${turns} join ${threads} on ${turns.threadId} = ${qualified(threads.id)}
          where ${threads.projectId} = ${qualified(projects.id)}
          order by ${qualified(turns.createdAt)} desc
          limit 1
        ), false)`,
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
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.workspaceId, workspaceId))
      .orderBy(asc(projects.name))
      .then((rows) =>
        rows.map((row) => ({
          ...row,
          workspaceKind: row.workspaceKind === "session" ? ("session" as const) : ("project" as const),
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
    if (!(await this.canView(workspaceId, userId))) return null;

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
    if (!(await this.canView(workspaceId, userId))) return null;

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
  /** Whether a project has a public site, and where. */
  async publicSite(hash: string, userId: string): Promise<PublicSiteState | null> {
    const project = await this.findByHash(hash, userId);
    if (!project) return null;
    const [row] = await this.db
      .select({ slug: projects.publicSlug, enabled: projects.publicEnabled })
      .from(projects)
      .where(eq(projects.id, project.id))
      .limit(1);
    return { enabled: row?.enabled ?? false, slug: row?.slug ?? null };
  }

  /**
   * Turns the read-only public site on or off.
   *
   * The slug is minted on the first enable and never replaced: someone who
   * was sent the link finds it working again after the owner toggles it off
   * and back on, and a stale link 404s in the meantime rather than landing
   * on a different project. Uniqueness is by the database; the six random
   * characters make a clash unlikely and the retry makes it harmless.
   */
  async setPublic(hash: string, userId: string, enabled: boolean): Promise<PublicSiteState | null> {
    const project = await this.findByHash(hash, userId);
    if (!project) return null;
    const current = await this.publicSite(hash, userId);
    let slug = current?.slug ?? null;
    if (enabled && !slug) {
      for (let attempt = 0; attempt < 5 && !slug; attempt++) {
        const candidate = publicSlugFor(project.name);
        try {
          await this.db
            .update(projects)
            .set({ publicSlug: candidate, publicEnabled: true })
            .where(eq(projects.id, project.id));
          slug = candidate;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      if (!slug) throw new Error("could not find an unused public address");
      return { enabled: true, slug };
    }
    await this.db.update(projects).set({ publicEnabled: enabled }).where(eq(projects.id, project.id));
    return { enabled, slug };
  }

  /**
   * The project behind a public address, or null when there is none or it
   * is switched off -- the two are the same to a visitor.
   */
  async findPublic(slug: string): Promise<PublicProject | null> {
    const [row] = await this.db
      .select({ id: projects.id, hash: projects.hash, name: projects.name, slug: projects.publicSlug })
      .from(projects)
      .where(and(eq(projects.publicSlug, slug), eq(projects.publicEnabled, true)))
      .limit(1);
    if (!row || !row.slug) return null;
    return { id: row.id, hash: row.hash, name: row.name, slug: row.slug };
  }

  /**
   * Records how the project is previewed: the port the owner's dev server
   * listens on, or -- with `staticDir` -- the folder of a static site, served
   * on `port`'s subdomain. A null port clears both. Goes through
   * `findByHash`, so somebody else's hash is refused the same way a missing
   * one is.
   */
  async setPreview(
    hash: string,
    userId: string,
    preview: { port: number | null; staticDir: string | null },
  ): Promise<ProjectSummary | null> {
    const project = await this.findByHash(hash, userId);
    if (!project) return null;
    const next = {
      previewPort: preview.port,
      previewStaticDir: preview.port === null ? null : preview.staticDir,
    };
    await this.db.update(projects).set(next).where(eq(projects.id, project.id));
    return { ...project, ...next };
  }

  /**
   * Where the project's code now lives, once a remote has been added to a
   * project that was started rather than cloned. By id rather than hash:
   * the git routes have already resolved the caller's project.
   */
  async setRepoUrl(projectId: string, repoUrl: string | null): Promise<void> {
    await this.db.update(projects).set({ repoUrl }).where(eq(projects.id, projectId));
  }

  /**
   * The same token sums `stats` makes, for one project. The caller has
   * already resolved the project through `findByHash`, which is the
   * ownership check.
   */
  async projectUsage(projectId: string): Promise<ProjectUsage> {
    const usage = (key: string) =>
      sql<number>`coalesce(sum((${turns.usage} ->> ${key})::double precision), 0)`;

    const [row] = await this.db
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
      .where(eq(threads.projectId, projectId));

    const tokens = {
      input: Number(row?.input ?? 0),
      output: Number(row?.output ?? 0),
      cacheRead: Number(row?.cacheRead ?? 0),
      cacheWrite: Number(row?.cacheWrite ?? 0),
    };
    return {
      tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite },
      costUsd: Number(row?.costUsd ?? 0),
      turnCount: Number(row?.turnCount ?? 0),
    };
  }

  /**
   * What the preview proxy needs to serve a subdomain, by hash alone. Not
   * user-scoped: by the time a request reaches the proxy the visitor's
   * authorization is in the preview cookie, which names the project it was
   * issued for; this only says which port that project has claimed.
   */
  async previewTarget(
    hash: string,
  ): Promise<{ id: string; userId: string; previewPort: number | null; previewStaticDir: string | null } | null> {
    const [row] = await this.db
      .select({
        id: projects.id,
        userId: projects.userId,
        previewPort: projects.previewPort,
        previewStaticDir: projects.previewStaticDir,
      })
      .from(projects)
      .where(eq(projects.hash, hash))
      .limit(1);
    return row ?? null;
  }

  async deleteProject(
    hash: string,
    userId: string,
  ): Promise<{ projectId: string } | { error: "not_found" | "forbidden" | "busy" }> {
    // Through `findByHash`, so a hash in somebody else's workspace is refused
    // by the same predicate that refuses one that does not exist.
    const project = await this.findByHash(hash, userId);
    if (!project) return { error: "not_found" };
    if (!can(project.membership, "workspace.manage")) return { error: "forbidden" };

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
   * The caller's membership of a workspace, or null when they have none --
   * which is also the answer for a workspace that does not exist, so the two
   * cannot be told apart.
   */
  async membership(workspaceId: string, userId: string): Promise<Membership | null> {
    const [row] = await this.db
      .select({
        role: workspaceMembers.role,
        canCreateProject: workspaceMembers.canCreateProject,
        canCreateSession: workspaceMembers.canCreateSession,
      })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .limit(1);
    return row ? toMembership(row) : null;
  }

  async canView(workspaceId: string, userId: string): Promise<boolean> {
    return (await this.membership(workspaceId, userId)) !== null;
  }

  async allows(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<boolean> {
    return can(await this.membership(workspaceId, userId), permission);
  }

  /**
   * The first workspace for a new account. Named after the person rather than
   * left blank, so the switcher has something meaningful in it on first load.
   */
  async ensureDefault(userId: string, name = "Personal"): Promise<WorkspaceSummary> {
    // An archived workspace does not count: someone who archived every one
    // they had still needs somewhere to land. Nor does one shared with them,
    // which they can be removed from.
    const existing = (await this.list(userId)).filter((w) => !w.archived && !w.shared);
    if (existing.length > 0) return existing[0]!;

    const created = await this.create(userId, name);
    if ("conflict" in created) {
      // Another boot won the race; whichever landed first is fine.
      const all = (await this.list(userId)).filter((w) => !w.shared);
      return all.find((w) => !w.archived) ?? all[0]!;
    }
    return created;
  }

  /**
   * Slugs are unique per owner, so a second "Acme" becomes "acme-2". Gives up
   * after a bounded number of attempts rather than looping forever.
   */
  /** A workspace hash nobody holds yet; the column's unique constraint is the backstop. */
  async #uniqueHash(): Promise<string> {
    for (;;) {
      const hash = generateHash();
      const [taken] = await this.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.hash, hash))
        .limit(1);
      if (!taken) return hash;
    }
  }

  async #uniqueSlug(userId: string, name: string): Promise<string | null> {
    const base = slugify(name);
    // Unique per owner, so only the caller's own workspaces can collide.
    const own = await this.db
      .select({ slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.ownerUserId, userId));
    const taken = new Set(own.map((w) => w.slug));

    if (!taken.has(base)) return base;
    for (let i = 2; i <= 50; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return null;
  }
}

export interface PublicSiteState {
  enabled: boolean;
  /** Null until the site has been enabled once. */
  slug: string | null;
}

/** What the public routes know about a project: enough to serve it, no more. */
export interface PublicProject {
  id: string;
  hash: string;
  name: string;
  slug: string;
}

/**
 * The address shape: `{name}-{12 chars}`, which is what the web app routes on.
 * Six-character tokens minted before the switch to twelve still resolve.
 */
export const PUBLIC_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?-[a-z0-9]{6}(?:[a-z0-9]{6})?$/;

/**
 * `my-project-k3f9x2m81qza`: the name, made a slug, and twelve characters of
 * chance -- the slug is the whole grant, so it has to be too many to guess.
 */
export function publicSlugFor(name: string): string {
  const base = slugify(name).slice(0, 40).replace(/-+$/, "") || "project";
  return `${base}-${shortToken()}`;
}

function shortToken(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(12);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
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
