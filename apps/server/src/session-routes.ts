import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { projects, threads, turns, users, workspaces, type Database } from "@ucch/db";
import { LIMIT_STOP_REASONS } from "@ucch/protocol";

/** A thread the Tasks pipeline opened (`task-pipeline.ts`), not a conversation. */
function isTaskThreadTitle(title: string): boolean {
  return title.startsWith("Task: ") || title.startsWith("Verify: ");
}

/** One session as the sidebar lists it, with its project. */
export interface WorkspaceSessionRow {
  id: string;
  hash: string | null;
  title: string;
  status: string;
  provider: string | null;
  /** The model its latest turn ran on; null before its first turn. */
  model: string | null;
  /**
   * How its latest turn ended: `done`, `failed` (an error, or cut off by a
   * limit), `stopped` (cancelled); null before its first turn.
   */
  lastTurn: "done" | "failed" | "stopped" | null;
  branch: string | null;
  baseBranch: string | null;
  worktreeState: string | null;
  pinned: boolean;
  archivedAt: Date | null;
  lastActivityAt: Date;
  createdAt: Date;
  createdByUserId: string | null;
  project: { id: string; hash: string; name: string; stack: string | null };
}

export const SidebarMode = z.enum(["sessions", "projects"]);
export type SidebarMode = z.infer<typeof SidebarMode>;

/**
 * Every session in a workspace, newest activity first, and the workspace's
 * projects (the empty ones too, for the grouped view). The Tasks board's
 * threads are its own and left out, as the project sidebar leaves them out.
 */
export async function listWorkspaceSessions(
  db: Database,
  workspaceId: string,
  { archived = false }: { archived?: boolean } = {},
): Promise<{
  sessions: WorkspaceSessionRow[];
  projects: { id: string; hash: string; name: string; stack: string | null; lastActiveAt: Date | null }[];
}> {
  const latestModel = sql<string | null>`(
    select ${turns.model} from ${turns}
    where ${turns.threadId} = ${threads.id}
    order by ${turns.seq} desc limit 1
  )`;
  const lastTurn = sql<"done" | "failed" | "stopped" | null>`(
    select case
      when ${turns.error} is not null then 'failed'
      when ${turns.stopReason} = 'cancelled' then 'stopped'
      when ${inArray(turns.stopReason, [...LIMIT_STOP_REASONS])} or ${turns.stopReason} like 'error%' then 'failed'
      else 'done'
    end
    from ${turns}
    where ${turns.threadId} = ${threads.id}
    order by ${turns.seq} desc limit 1
  )`;
  const rows = await db
    .select({
      id: threads.id,
      hash: threads.hash,
      title: threads.title,
      status: threads.status,
      provider: threads.provider,
      model: latestModel,
      lastTurn,
      branch: threads.branch,
      baseBranch: threads.baseBranch,
      worktreeState: threads.worktreeState,
      pinned: threads.pinned,
      archivedAt: threads.archivedAt,
      lastActivityAt: threads.lastActivityAt,
      createdAt: threads.createdAt,
      createdByUserId: threads.createdByUserId,
      projectId: projects.id,
      projectHash: projects.hash,
      projectName: projects.name,
      projectStack: projects.stack,
    })
    .from(threads)
    .innerJoin(projects, eq(projects.id, threads.projectId))
    .where(and(eq(projects.workspaceId, workspaceId), archived ? undefined : isNull(threads.archivedAt)))
    .orderBy(desc(threads.lastActivityAt))
    // Far more than a sidebar shows at once; the list is windowed.
    .limit(2000);

  const projectRows = await db
    .select({
      id: projects.id,
      hash: projects.hash,
      name: projects.name,
      stack: projects.stack,
      lastActiveAt: projects.lastActiveAt,
    })
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId));

  return {
    sessions: rows
      .filter((r) => !isTaskThreadTitle(r.title))
      .map(({ projectId, projectHash, projectName, projectStack, ...row }) => ({
        ...row,
        project: { id: projectId, hash: projectHash, name: projectName, stack: projectStack },
      })),
    projects: projectRows,
  };
}

export interface SessionRouteDeps {
  db: Database;
  principal: (request: FastifyRequest) => Promise<{ userId: string } | null>;
  /** Whether the caller is a member of the workspace (any role). */
  canView: (workspaceId: string, userId: string) => Promise<boolean>;
}

/**
 * `GET /api/workspaces/:id/sessions` for the sidebar, and the account's
 * sidebar mode (`GET`/`PUT /api/account/sidebar-mode`), mirrored from the
 * browser so a second device opens the same way.
 */
export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  app.get<{ Params: { id: string }; Querystring: { archived?: string } }>(
    "/api/workspaces/:id/sessions",
    async (request, reply) => {
      const principal = await deps.principal(request);
      if (!principal) return reply.code(401).send({ error: "unauthorized" });
      if (!z.string().uuid().safeParse(request.params.id).success) {
        return reply.code(404).send({ error: "workspace not found" });
      }
      // Not yours and not there read the same.
      if (!(await deps.canView(request.params.id, principal.userId))) {
        return reply.code(404).send({ error: "workspace not found" });
      }
      const [workspace] = await deps.db
        .select({ name: workspaces.name })
        .from(workspaces)
        .where(eq(workspaces.id, request.params.id))
        .limit(1);
      const listed = await listWorkspaceSessions(deps.db, request.params.id, {
        archived: request.query.archived === "1",
      });
      return { workspaceName: workspace?.name ?? null, ...listed };
    },
  );

  app.get("/api/account/sidebar-mode", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const [row] = await deps.db
      .select({ mode: users.sidebarMode })
      .from(users)
      .where(eq(users.id, principal.userId))
      .limit(1);
    const mode = SidebarMode.safeParse(row?.mode);
    return { mode: mode.success ? mode.data : null };
  });

  app.put("/api/account/sidebar-mode", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const parsed = z.object({ mode: SidebarMode }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "mode is sessions or projects" });
    await deps.db.update(users).set({ sidebarMode: parsed.data.mode }).where(eq(users.id, principal.userId));
    return { mode: parsed.data.mode };
  });
}
