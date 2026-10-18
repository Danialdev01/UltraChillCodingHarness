import { join } from "node:path";

/**
 * Where a project's files are on disk.
 *
 * The project's own checkout is `WORKSPACE_ROOT/{projectId}`. A project
 * session -- a thread created with a base branch -- works in a git worktree
 * of it at `WORKSPACE_ROOT/.worktrees/{projectId}/{threadHash}`: beside the
 * project rather than inside it, so it never shows in the project's own
 * `git status`, the way `.uploads` stays out of every tree.
 *
 * Every id here is a uuid or a hash from the database, never caller text, so
 * none of these can climb out of the root.
 */
export function projectRoot(workspaceRoot: string, projectId: string): string {
  return join(workspaceRoot, projectId);
}

/** Every session worktree a project has, removed with the project. */
export function sessionTreesOf(workspaceRoot: string, projectId: string): string {
  return join(workspaceRoot, ".worktrees", projectId);
}

export function sessionTree(workspaceRoot: string, projectId: string, threadHash: string): string {
  return join(sessionTreesOf(workspaceRoot, projectId), threadHash);
}

/**
 * What the file and git services work on: a project's checkout by its id, or
 * a session's worktree already resolved through `treeFor`.
 */
export type TreeTarget = string | { projectId: string; tree: string };

/** The project a target belongs to, for the events and checks keyed by it. */
export function projectOf(target: TreeTarget): string {
  return typeof target === "string" ? target : target.projectId;
}

/** The parts of a thread row that decide which folder it works in. */
export interface TreeThread {
  projectId: string;
  hash: string;
  worktreeState: string | null;
}

/**
 * The folder a thread works in: its own worktree once that exists, the
 * project's checkout for every thread without one.
 */
export function treeFor(workspaceRoot: string, projectId: string, thread?: TreeThread | null): string {
  if (thread && thread.projectId === projectId && thread.worktreeState === "ready") {
    return sessionTree(workspaceRoot, projectId, thread.hash);
  }
  return projectRoot(workspaceRoot, projectId);
}
