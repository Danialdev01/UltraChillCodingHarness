import { and, eq } from "drizzle-orm";
import { projects, threads, workspaces, type Database } from "@ucch/db";

/**
 * Who may see and change a project.
 *
 * Today that is the owner of the project's workspace and nobody else. Every
 * live path asks here -- the socket's subscriptions, the shared prompt box,
 * presence -- so that when projects are shared, this is the one place that
 * learns about members, alongside `WorkspaceService.findByHash` for the
 * REST routes.
 */
export class ProjectAccess {
  constructor(private readonly db: Database) {}

  async canAccessProject(userId: string, projectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
      .where(and(eq(projects.id, projectId), eq(workspaces.ownerUserId, userId)))
      .limit(1);
    return Boolean(row);
  }

  /** The thread's project when the caller may see it, else null. */
  async threadProject(userId: string, threadId: string): Promise<string | null> {
    const projectId = await this.projectOfThread(threadId);
    if (!projectId) return null;
    return (await this.canAccessProject(userId, projectId)) ? projectId : null;
  }

  /** The thread's project, unchecked: for routing, never for permission. */
  async projectOfThread(threadId: string): Promise<string | null> {
    const cached = this.#threads.get(threadId);
    if (cached) return cached;
    const [row] = await this.db
      .select({ projectId: threads.projectId })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    if (!row) return null;
    // A thread never moves between projects, so the answer can be kept.
    if (this.#threads.size > 10_000) this.#threads.clear();
    this.#threads.set(threadId, row.projectId);
    return row.projectId;
  }

  #threads = new Map<string, string>();
}
