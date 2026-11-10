import type { DomainEvent } from "@ucch/protocol";
import type { GitAuthor, GitService } from "./git.js";
import { ProjectGit, type SettleOutcome } from "./project-git.js";
import { sessionTree, treeHashOf } from "./trees.js";

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
  /** Set when it works in another session's worktree: that one's hash. */
  treeHash?: string | null;
}

/** The other sessions working in one session's folder: a handoff's two ends. */
export interface TreeSharers {
  count: number;
  /** Whether any of them has a turn in flight. */
  running: boolean;
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
  /** Other sessions in the same worktree, which keep it when this one goes. */
  sharers: TreeSharers;
}

/** What Project Settings says about where sessions land. */
export interface ProjectSettleSettings {
  baseBranch: string;
  autoPushBase: boolean;
  deleteBranchOnSettle: boolean;
}

/** What `settle` did: merged (or failed to), or -- with nothing to merge -- removed. */
export type SettleResult = SettleOutcome | { state: "removed" };

export interface SessionLifecycleDeps {
  git: GitService;
  /** The project repositories' git; shared with the worktree reactor for its lock. */
  projectGit?: ProjectGit;
  workspaceRoot: string;
  /** The project's base branch and settle options, as stored now. */
  projectSettings(projectId: string): Promise<ProjectSettleSettings>;
  /** Records a settle's outcome on the session's row. */
  markSettled(session: SessionRecord, outcome: SettleOutcome): Promise<void>;
  turnCount(threadId: string): Promise<number>;
  /**
   * The other sessions whose folder is this one's (`threads.tree_hash`, or
   * the hash it names). None when absent.
   */
  sharers?(session: SessionRecord): Promise<TreeSharers>;
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
 * A project session works in a worktree of its own on `ucch/{hash}`,
 * forked from the project's base branch, so its files exist nowhere else
 * until they are merged. Settling one commits whatever is uncommitted and
 * merges the branch into the project's base branch, and only then removes
 * the worktree (and, by the project's setting, the branch); the thread is
 * kept, marked settled. A merge that conflicts is aborted and nothing is
 * removed. A session with nothing in it -- no turn run, no edit, no
 * commit -- is removed without any of that.
 *
 * A session in the project's main checkout (no branch of its own) has no
 * files to lose: its edits are the project's, and stay where they are.
 *
 * A handoff leaves two sessions in one worktree (solution §5.4). Either
 * can go; the worktree and its branch go with the last of them, and none is
 * settled while another is working in it.
 */
export class SessionLifecycle {
  readonly #projectGit: ProjectGit;

  constructor(private readonly deps: SessionLifecycleDeps) {
    this.#projectGit = deps.projectGit ?? new ProjectGit(deps.workspaceRoot);
  }

  #tree(session: SessionRecord): { projectId: string; tree: string } | null {
    if (!session.branch || session.worktreeState !== "ready") return null;
    return {
      projectId: session.projectId,
      tree: sessionTree(this.deps.workspaceRoot, session.projectId, treeHashOf(session)),
    };
  }

  async inspect(session: SessionRecord): Promise<SessionInspection> {
    const running = session.status === "queued" || session.status === "running" || session.status === "cancelling";
    const [turns, sharers] = await Promise.all([
      this.deps.turnCount(session.id),
      this.deps.sharers?.(session) ?? Promise.resolve({ count: 0, running: false }),
    ]);
    const tree = this.#tree(session);
    if (!tree) return { turns, dirty: false, unpushed: 0, hasRemote: false, running, sharers };

    const status = await this.deps.git.status(tree);
    const unpushed = status.upstream
      ? status.ahead
      : session.baseBranch
        ? await this.deps.git.commitsSince(tree, session.baseBranch)
        : 0;
    return { turns, dirty: status.files.length > 0, unpushed, hasRemote: status.hasRemote, running, sharers };
  }

  /** Nothing said, nothing changed, nothing running. */
  static isEmpty(inspection: SessionInspection): boolean {
    return inspection.turns === 0 && !inspection.dirty && inspection.unpushed === 0 && !inspection.running;
  }

  /** Removes the session only if it is empty. Never commits or pushes. */
  async removeIfEmpty(session: SessionRecord): Promise<boolean> {
    const inspection = await this.inspect(session);
    if (!SessionLifecycle.isEmpty(inspection)) return false;
    await this.#remove(session, null, inspection.sharers.count > 0);
    return true;
  }

  /**
   * Settles a session: whatever it left uncommitted is committed, its
   * branch is merged into the project's base branch (Project Settings'
   * choice now, not the one it was created from), and its worktree removed
   * -- all under the project's lock (`ProjectGit.settle`). The thread stays,
   * marked settled with the merge commit, or failed with the conflicting
   * files, in which case its worktree and branch are left as they were.
   *
   * A session with no worktree of its own has nothing to merge, and one
   * whose worktree another session still works in leaves the merge to that
   * one (the last of them): both are simply removed, as before.
   */
  async settle(session: SessionRecord): Promise<SettleResult> {
    const inspection = await this.inspect(session);
    SessionLifecycle.#idle(inspection, "settle");

    const tree = this.#tree(session);
    if (!tree || !session.branch || inspection.sharers.count > 0) {
      await this.#remove(session, null, inspection.sharers.count > 0);
      return { state: "removed" };
    }

    const settings = await this.deps.projectSettings(session.projectId);
    // The base as set now; the one it was created from only when that is gone.
    let baseBranch = settings.baseBranch;
    if (!(await this.#projectGit.branchExists(session.projectId, baseBranch)) && session.baseBranch) {
      baseBranch = session.baseBranch;
    }
    const { token, author } = await this.deps.credentials(session.projectId);
    const outcome = await this.#projectGit.settle({
      projectId: session.projectId,
      hash: session.hash,
      tree: tree.tree,
      branch: session.branch,
      baseBranch,
      title: session.title,
      author,
      token,
      deleteBranch: settings.deleteBranchOnSettle,
      autoPush: settings.autoPushBase,
    });
    if (outcome.state === "settled" && outcome.cleanupError) {
      this.deps.onCleanupError?.(new Error(outcome.cleanupError), session);
    }

    await this.deps.markSettled(session, outcome);
    await this.deps.announce(session.projectId, {
      type: "thread.settled",
      projectId: session.projectId,
      threadId: session.id,
      hash: session.hash,
      state: outcome.state,
      baseBranch: outcome.baseBranch,
      mergeCommitSha: outcome.state === "settled" ? outcome.mergeCommitSha : null,
      conflicts: outcome.state === "failed" ? outcome.conflicts : [],
      error: outcome.state === "failed" ? outcome.error : outcome.pushError,
    });
    return outcome;
  }

  /**
   * Removes a session without keeping its work: uncommitted edits and
   * commits that never reached origin are dropped with the worktree and the
   * local branch. Nothing is committed or pushed. What the person asked for
   * when they chose not to commit.
   */
  async discard(session: SessionRecord): Promise<void> {
    const inspection = await this.inspect(session);
    SessionLifecycle.#idle(inspection, "discard it");
    await this.#remove(session, null, inspection.sharers.count > 0);
  }

  /** Refuses while an agent works in the session's worktree. */
  static #idle(inspection: SessionInspection, then: string): void {
    if (inspection.running) {
      throw new SessionBusyError(`the agent is still working in this session -- stop it, then ${then}`);
    }
    if (inspection.sharers.running) {
      // Committing (or deleting) under an agent that is writing the same
      // files would push half of its edit, or pull the floor from under it.
      throw new SessionBusyError(`the session this one was handed off to is still working in its worktree -- stop it, then ${then}`);
    }
  }

  /**
   * The row first, then the disk: a failure part-way leaves a stray folder
   * (logged, harmless) rather than a session pointing at a tree that is gone.
   * A worktree another session still works in is left to it.
   */
  async #remove(session: SessionRecord, pushedBranch: string | null, shared: boolean): Promise<void> {
    await this.deps.deleteThread(session.id);
    // A settled session's worktree is gone already.
    if (session.branch && !shared && session.worktreeState !== "settled") {
      const tree = sessionTree(this.deps.workspaceRoot, session.projectId, treeHashOf(session));
      try {
        // Empty, or discarded on purpose: the branch goes with the tree.
        await this.#projectGit.removeWorktree(session.projectId, tree, session.branch);
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
