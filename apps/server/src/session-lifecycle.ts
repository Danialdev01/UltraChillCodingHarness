import { rm } from "node:fs/promises";
import type { DomainEvent } from "@ucch/protocol";
import { runGit } from "./git-exec.js";
import type { GitAuthor, GitService } from "./git.js";
import { projectRoot, sessionTree } from "./trees.js";

const TIMEOUT_MS = 60_000;

/** A project session as the lifecycle needs it: its thread row, in short. */
export interface SessionRecord {
  id: string;
  projectId: string;
  hash: string;
  title: string;
  status: string;
  branch: string | null;
  baseBranch: string | null;
  worktreeState: string | null;
}

/** What a session holds that removing it could lose. */
export interface SessionInspection {
  /** Turns run in it: a conversation, even one that changed no file. */
  turns: number;
  /** Uncommitted edits in its worktree. */
  dirty: boolean;
  /** Commits on its branch that origin does not have. */
  unpushed: number;
  hasRemote: boolean;
  running: boolean;
}

export interface SessionLifecycleDeps {
  git: GitService;
  workspaceRoot: string;
  turnCount(threadId: string): Promise<number>;
  /** Deletes the thread row; its events and turns go with it. */
  deleteThread(threadId: string): Promise<void>;
  /** The token for origin (null when it does not apply) and whose name commits carry. */
  credentials(projectId: string): Promise<{ token: string | null; author: GitAuthor }>;
  /** Tells the project's open views. Never throws. */
  announce(projectId: string, event: DomainEvent): Promise<void>;
  onCleanupError?(error: unknown, session: SessionRecord): void;
}

/** Refused for a reason the person can act on; the route answers 409. */
export class SessionBusyError extends Error {}

/** A session's work could not be put somewhere safe, so it was not removed. */
export class SessionUnsavedError extends Error {}

/**
 * Removing project sessions without losing what is in them.
 *
 * A project session works in a worktree of its own on `ucch/{hash}`, so its
 * files exist nowhere else until they are pushed. Settling one therefore
 * commits whatever is uncommitted and pushes the branch to origin first,
 * and only then deletes the thread, the worktree and the local branch; if
 * that cannot happen, nothing is removed. A session with nothing in it --
 * no turn run, no edit, no commit -- is removed without any of that.
 *
 * A session in the project's main checkout (no branch of its own) has no
 * files to lose: its edits are the project's, and stay where they are.
 */
export class SessionLifecycle {
  constructor(private readonly deps: SessionLifecycleDeps) {}

  #tree(session: SessionRecord): { projectId: string; tree: string } | null {
    if (!session.branch || session.worktreeState !== "ready") return null;
    return {
      projectId: session.projectId,
      tree: sessionTree(this.deps.workspaceRoot, session.projectId, session.hash),
    };
  }

  async inspect(session: SessionRecord): Promise<SessionInspection> {
    const running = session.status === "queued" || session.status === "running" || session.status === "cancelling";
    const turns = await this.deps.turnCount(session.id);
    const tree = this.#tree(session);
    if (!tree) return { turns, dirty: false, unpushed: 0, hasRemote: false, running };

    const status = await this.deps.git.status(tree);
    const unpushed = status.upstream
      ? status.ahead
      : session.baseBranch
        ? await this.deps.git.commitsSince(tree, session.baseBranch)
        : 0;
    return { turns, dirty: status.files.length > 0, unpushed, hasRemote: status.hasRemote, running };
  }

  /** Nothing said, nothing changed, nothing running. */
  static isEmpty(inspection: SessionInspection): boolean {
    return inspection.turns === 0 && !inspection.dirty && inspection.unpushed === 0 && !inspection.running;
  }

  /** Removes the session only if it is empty. Never commits or pushes. */
  async removeIfEmpty(session: SessionRecord): Promise<boolean> {
    if (!SessionLifecycle.isEmpty(await this.inspect(session))) return false;
    await this.#remove(session, null);
    return true;
  }

  /**
   * Settles a session: its work committed and pushed to origin when it has
   * any, then the session removed. Answers with the branch it pushed.
   */
  async settle(session: SessionRecord): Promise<{ pushed: string | null }> {
    const inspection = await this.inspect(session);
    if (inspection.running) {
      throw new SessionBusyError("the agent is still working in this session -- stop it, then settle");
    }

    const tree = this.#tree(session);
    let pushed: string | null = null;
    if (tree && (inspection.dirty || inspection.unpushed > 0)) {
      if (!inspection.hasRemote) {
        throw new SessionUnsavedError(
          "this session has changes and the project has no remote to push them to -- connect one in Git, or push them yourself",
        );
      }
      const { token, author } = await this.deps.credentials(session.projectId);
      if (inspection.dirty) {
        await this.deps.git.stage(tree, "all");
        await this.deps.git.commit(tree, { summary: `Session: ${session.title}` }, author);
      }
      try {
        pushed = (await this.deps.git.push(tree, token)).branch;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new SessionUnsavedError(`could not push this session's changes, so it was kept: ${reason}`);
      }
    }

    await this.#remove(session, pushed);
    return { pushed };
  }

  /**
   * The row first, then the disk: a failure part-way leaves a stray folder
   * (logged, harmless) rather than a session pointing at a tree that is gone.
   */
  async #remove(session: SessionRecord, pushedBranch: string | null): Promise<void> {
    await this.deps.deleteThread(session.id);
    if (session.branch) {
      const repo = projectRoot(this.deps.workspaceRoot, session.projectId);
      const tree = sessionTree(this.deps.workspaceRoot, session.projectId, session.hash);
      try {
        await runGit(["worktree", "remove", "--force", "--", tree], repo, TIMEOUT_MS, { okExitCodes: [0, 128] });
        await rm(tree, { recursive: true, force: true });
        await runGit(["worktree", "prune"], repo, TIMEOUT_MS);
        // Its commits are on origin, or there were none: the local branch
        // holds nothing that is not somewhere else.
        await runGit(["branch", "-D", "--", session.branch], repo, TIMEOUT_MS, { okExitCodes: [0, 1] });
      } catch (error) {
        this.deps.onCleanupError?.(error, session);
      }
    }
    await this.deps.announce(session.projectId, {
      type: "thread.removed",
      projectId: session.projectId,
      threadId: session.id,
      hash: session.hash,
      pushedBranch,
    });
  }
}
