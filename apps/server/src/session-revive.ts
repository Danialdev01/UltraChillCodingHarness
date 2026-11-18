import { and, eq } from "drizzle-orm";
import { projects, threads, workspaceMembers, workspaces, type Database } from "@ucch/db";
import { can, type DomainEvent } from "@ucch/protocol";
import type { Principal } from "./auth.js";
import { applyProjection } from "./engine.js";
import type { EventStore } from "./eventstore.js";
import type { ProjectGit } from "./project-git.js";
import { treeHashOf } from "./trees.js";

export interface ReviveDeps {
  db: Database;
  store: EventStore;
  projectGit: ProjectGit;
}

/**
 * Makes an archived or settled session active again, ahead of a message run
 * in it: by the person in the chat, or by another session's agent.
 *
 * Archived: back on the list. Settled: no longer settled, and -- in a project
 * workspace, where settling removed its worktree -- given its checkout back,
 * on its own branch if settling kept it, else forked afresh from the base its
 * work was merged into. A session workspace's settled session kept its files,
 * so there only the mark goes.
 *
 * Nothing happens unless `principal` may write to the session's project; the
 * send that follows is refused for the same reason anyway.
 */
export async function reviveSession(deps: ReviveDeps, principal: Principal, threadId: string): Promise<void> {
  const { db, store } = deps;
  const [row] = await db
    .select({ thread: threads, workspaceId: projects.workspaceId, owner: workspaces.ownerUserId })
    .from(threads)
    .innerJoin(projects, eq(projects.id, threads.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(eq(threads.id, threadId))
    .limit(1);
  if (!row) return;
  const { thread } = row;
  const archived = thread.archivedAt !== null;
  const settled = thread.settleState === "settled" || thread.worktreeState === "settled";
  if (!archived && !settled) return;
  if (!(await mayWrite(db, principal.userId, row.workspaceId, row.owner))) return;

  if (archived) {
    const events: DomainEvent[] = [{ type: "thread.updated", threadId, archived: false }];
    await store.append({ projectId: thread.projectId, threadId }, events, (tx) => applyProjection(tx, events, null));
  }
  if (!settled) return;

  // A project session whose worktree went with the settle: back first, so a
  // failure leaves the session settled rather than pointing at nothing.
  const restoreTree = thread.worktreeState === "settled" && Boolean(thread.branch);
  if (restoreTree) {
    const baseBranch = thread.settleBaseBranch ?? thread.baseBranch;
    if (!baseBranch) throw new Error("this settled session has no base branch to restore its worktree from");
    await deps.projectGit.restoreWorktree(thread.projectId, treeHashOf(thread), thread.branch!, baseBranch);
  }
  await db
    .update(threads)
    .set({
      settleState: null,
      settleError: null,
      settleConflicts: null,
      settledAt: null,
      mergeCommitSha: null,
      ...(restoreTree ? { worktreeState: "ready" as const, worktreeError: null } : {}),
    })
    .where(eq(threads.id, threadId));
  // Lists refetch on it, wherever the session is shown. A session without a
  // worktree of its own needs none: the turn about to start refetches them.
  if (restoreTree) {
    const ready: DomainEvent[] = [{ type: "thread.worktree_ready", threadId }];
    await store.append({ projectId: thread.projectId, threadId }, ready, (tx) => applyProjection(tx, ready, null));
  }
}

async function mayWrite(db: Database, userId: string, workspaceId: string | null, owner: string | null): Promise<boolean> {
  if (!workspaceId) return false;
  if (owner === userId) return true;
  const [membership] = await db
    .select({ role: workspaceMembers.role, canCreateProject: workspaceMembers.canCreateProject, canCreateSession: workspaceMembers.canCreateSession })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return Boolean(membership && can({ ...membership, role: membership.role as "owner" | "admin" | "member" | "viewer" }, "project.write"));
}
