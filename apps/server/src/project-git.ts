import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitError, runGit, type GitRunOptions } from "./git-exec.js";
import type { GitAuthor } from "./git.js";
import { projectRoot, sessionTree, sessionTreesOf } from "./trees.js";

const TIMEOUT_MS = 60_000;

/** How a settled session's branch is brought into the base branch. Only `no-ff` for now. */
export type MergeStrategy = "no-ff";

/** A settle that was refused before anything changed; the route answers 409. */
export class SettleRefusedError extends Error {}

export interface SettleInput {
  projectId: string;
  /** The session's hash: names its worktree folder and goes in the commit trailer. */
  hash: string;
  /** The session's worktree, or null for one that has none (nothing to merge). */
  tree: string | null;
  /** `ucch/{hash}`. */
  branch: string;
  /** The project's base branch, as Project Settings has it now. */
  baseBranch: string;
  title: string;
  author: GitAuthor;
  /** For origin, when it applies. */
  token: string | null;
  deleteBranch: boolean;
  autoPush: boolean;
  strategy?: MergeStrategy;
}

export type SettleOutcome =
  | {
      state: "settled";
      baseBranch: string;
      mergeCommitSha: string;
      /** Whether the base was pushed (auto-push on); `pushError` when that failed. */
      pushed: boolean;
      pushError: string | null;
      /** Cleanup after the merge that went wrong; the merge itself stands. */
      cleanupError: string | null;
    }
  | { state: "failed"; baseBranch: string; conflicts: string[]; error: string };

/**
 * Every git operation that touches a project's *repository* -- its refs, its
 * worktree list, its base branch -- rather than one working tree's index.
 *
 * Each call names the project, and the repository is resolved from it
 * (`projectRoot`) and passed as `-C` as well as the cwd: nothing here
 * depends on the server's own working directory, and nothing can reach
 * another project's repository or the server's own. `runGit` rebuilds the
 * environment from scratch, so an inherited `GIT_DIR` or `GIT_WORK_TREE`
 * cannot redirect a command either.
 *
 * Operations that change the repository's refs or worktree list run one at
 * a time per project (`withLock`): two sessions settling at once would
 * otherwise race for the base branch, and `worktree add`/`prune` for
 * `.git/worktrees`. Different projects never wait on each other.
 *
 * Repository hooks are switched off (`core.hooksPath=/dev/null`): a hook is
 * the repository's own code, and the server has no business running it.
 */
export class ProjectGit {
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly workspaceRoot: string,
    private readonly timeoutMs = TIMEOUT_MS,
  ) {}

  repo(projectId: string): string {
    return projectRoot(this.workspaceRoot, projectId);
  }

  /** Runs git against one directory of the project: its checkout, or a worktree of it. */
  async #run(dir: string, argv: string[], options: GitRunOptions = {}): Promise<string> {
    return runGit(["-C", dir, "-c", "core.hooksPath=/dev/null", ...argv], dir, this.timeoutMs, options);
  }

  git(projectId: string, argv: string[], options: GitRunOptions = {}): Promise<string> {
    return this.#run(this.repo(projectId), argv, options);
  }

  /** Runs `work` after anything else holding this project's lock. */
  withLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(projectId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.#locks.set(projectId, next);
    next
      .finally(() => {
        if (this.#locks.get(projectId) === next) this.#locks.delete(projectId);
      })
      .catch(() => {});
    return next;
  }

  // ---- base branch ------------------------------------------------------

  /**
   * The branch new sessions should fork from: origin's default branch
   * (`origin/HEAD`), else what `remote show origin` says it is, else the
   * branch the checkout is on. Null for a repository with none of these.
   */
  async detectBaseBranch(projectId: string): Promise<string | null> {
    const head = await this.git(projectId, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      okExitCodes: [0, 1, 128],
      read: true,
    }).catch(() => "");
    if (head.trim().startsWith("origin/")) return head.trim().slice("origin/".length);

    if (await this.#hasOrigin(projectId)) {
      const shown = await this.git(projectId, ["remote", "show", "origin"], { read: true }).catch(() => "");
      const match = /HEAD branch:\s*(\S+)/.exec(shown);
      if (match && match[1] !== "(unknown)") return match[1]!;
    }

    const current = await this.git(projectId, ["branch", "--show-current"], { read: true }).catch(() => "");
    return current.trim() || null;
  }

  /** Where a branch exists: locally, only on origin, or not at all. */
  async branchExists(projectId: string, name: string): Promise<"local" | "remote" | null> {
    if (!(await this.#validBranchName(projectId, name))) return null;
    if (await this.#refExists(this.repo(projectId), `refs/heads/${name}`)) return "local";
    if (await this.#refExists(this.repo(projectId), `refs/remotes/origin/${name}`)) return "remote";
    return null;
  }

  async #validBranchName(projectId: string, name: string): Promise<boolean> {
    if (!name || name.startsWith("-")) return false;
    return this.git(projectId, ["check-ref-format", "--branch", name], { read: true }).then(
      () => true,
      () => false,
    );
  }

  async #refExists(dir: string, ref: string): Promise<boolean> {
    const out = await this.#run(dir, ["rev-parse", "--verify", "--quiet", ref], { okExitCodes: [0, 1], read: true });
    return out.trim().length > 0;
  }

  async #hasOrigin(projectId: string): Promise<boolean> {
    const remotes = await this.git(projectId, ["remote"], { read: true }).catch(() => "");
    return remotes.split("\n").some((r) => r.trim() === "origin");
  }

  // ---- worktrees --------------------------------------------------------

  /**
   * Gives a session its own checkout: `ucch/{hash}` forked from `baseBranch`,
   * at `.worktrees/{projectId}/{hash}`. A base that exists only on origin
   * is forked from `origin/{base}`.
   */
  addWorktree(projectId: string, hash: string, branch: string, baseBranch: string): Promise<string> {
    return this.withLock(projectId, async () => {
      const tree = sessionTree(this.workspaceRoot, projectId, hash);
      const where = await this.branchExists(projectId, baseBranch);
      const start = where === "remote" ? `origin/${baseBranch}` : baseBranch;
      await mkdir(dirname(tree), { recursive: true });
      try {
        // `--` keeps a base branch from ever being read as an option.
        await this.git(projectId, ["worktree", "add", "-b", branch, "--", tree, start]);
      } catch (error) {
        // A half-made tree would be refused by the next attempt; clear it
        // and let git forget it.
        await rm(tree, { recursive: true, force: true }).catch(() => {});
        await this.git(projectId, ["worktree", "prune"]).catch(() => {});
        throw error;
      }
      return tree;
    });
  }

  /**
   * Removes a session's worktree and, when asked, its branch. Never touches
   * any other branch.
   */
  removeWorktree(projectId: string, tree: string, branch: string | null): Promise<void> {
    return this.withLock(projectId, () => this.#removeWorktree(projectId, tree, branch));
  }

  async #removeWorktree(projectId: string, tree: string, branch: string | null): Promise<void> {
    await this.git(projectId, ["worktree", "remove", "--force", "--", tree], { okExitCodes: [0, 128] });
    await rm(tree, { recursive: true, force: true });
    await this.git(projectId, ["worktree", "prune"]);
    if (branch) await this.git(projectId, ["branch", "-D", "--", branch], { okExitCodes: [0, 1] });
  }

  prune(projectId: string): Promise<void> {
    return this.withLock(projectId, async () => {
      await this.git(projectId, ["worktree", "prune"]);
    });
  }

  /** The worktree a branch is checked out in, if any. */
  async #checkedOutAt(projectId: string, branch: string): Promise<string | null> {
    const out = await this.git(projectId, ["worktree", "list", "--porcelain"], { read: true });
    let path: string | null = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line === `branch refs/heads/${branch}`) return path;
    }
    return null;
  }

  // ---- settle -----------------------------------------------------------

  /**
   * Commits whatever the session left uncommitted, merges its branch into
   * the base branch, and removes its worktree -- under the project's lock.
   *
   * The base is brought up to origin's first when it tracks one (a fast
   * forward only; a base that has diverged from origin is refused). The
   * merge happens in the checkout that has the base checked out, which must
   * be clean, or in a temporary worktree of it when none has.
   *
   * A conflict aborts the merge and verifies the base is where it was: the
   * base branch is never left mid-merge, and the session keeps its worktree
   * and branch. Nothing here force-pushes or rewrites the base's history.
   */
  settle(input: SettleInput): Promise<SettleOutcome> {
    return this.withLock(input.projectId, () => this.#settle(input));
  }

  async #settle(input: SettleInput): Promise<SettleOutcome> {
    const { projectId, branch, baseBranch, author } = input;
    const who = ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];
    const repo = this.repo(projectId);

    if (!(await this.#validBranchName(projectId, baseBranch))) {
      throw new SettleRefusedError(`"${baseBranch}" is not a valid base branch -- set one in Project Settings`);
    }

    // 1. Commit what the session left uncommitted.
    if (input.tree && (await exists(input.tree))) {
      const dirty = (await this.#run(input.tree, ["status", "--porcelain"], { read: true })).trim();
      if (dirty) {
        const files = dirty
          .split("\n")
          .map((line) => line.slice(3))
          .slice(0, 50);
        await this.#run(input.tree, ["add", "-A"]);
        await this.#run(input.tree, [
          ...who,
          "commit",
          "--no-verify",
          "-m",
          `Settle session: ${input.title}`,
          "-m",
          `Changes left uncommitted when the session was settled:\n\n${files.map((f) => `- ${f}`).join("\n")}`,
          "-m",
          `UCCH-Session: ${input.hash}`,
        ]);
      }
    }

    if (!(await this.#refExists(repo, `refs/heads/${branch}`))) {
      throw new SettleRefusedError(`the session's branch ${branch} no longer exists in this project`);
    }

    // 2. A local base, up to date with origin's when it has one.
    const hasOrigin = await this.#hasOrigin(projectId);
    if (hasOrigin) {
      try {
        await this.git(projectId, [
          "fetch",
          "--quiet",
          "origin",
          // Explicit: a single-branch clone's refspec would not map another base.
          `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
        ], { token: input.token, okExitCodes: [0] });
      } catch (error) {
        // A base that origin does not have is a local-only branch; anything
        // else (offline, auth) means we cannot know whether we are current.
        if (!(error instanceof GitError && /couldn't find remote ref/i.test(error.stderr))) {
          throw new SettleRefusedError(`could not update ${baseBranch} from origin: ${describe(error)}`);
        }
      }
    }
    const remoteRef = `refs/remotes/origin/${baseBranch}`;
    const hasRemoteBase = hasOrigin && (await this.#refExists(repo, remoteRef));
    if (!(await this.#refExists(repo, `refs/heads/${baseBranch}`))) {
      if (!hasRemoteBase) {
        throw new SettleRefusedError(`the base branch ${baseBranch} does not exist -- pick another in Project Settings`);
      }
      await this.git(projectId, ["branch", "--", baseBranch, `origin/${baseBranch}`]);
    }

    let mergeDir = await this.#checkedOutAt(projectId, baseBranch);
    if (mergeDir) {
      const changes = (
        await this.#run(mergeDir, ["status", "--porcelain", "--untracked-files=no"], { read: true })
      ).trim();
      if (changes) {
        throw new SettleRefusedError(
          `the project checkout has uncommitted changes on ${baseBranch} -- commit or discard them, then settle`,
        );
      }
    }

    if (hasRemoteBase) {
      const local = (await this.git(projectId, ["rev-parse", `refs/heads/${baseBranch}`])).trim();
      const remote = (await this.git(projectId, ["rev-parse", remoteRef])).trim();
      if (local !== remote) {
        if (await this.#isAncestor(projectId, local, remote)) {
          // Behind origin: fast-forward, nothing else.
          if (mergeDir) await this.#run(mergeDir, ["merge", "--ff-only", "--quiet", remote]);
          else await this.git(projectId, ["update-ref", `refs/heads/${baseBranch}`, remote, local]);
        } else if (!(await this.#isAncestor(projectId, remote, local))) {
          throw new SettleRefusedError(
            `${baseBranch} has diverged from origin/${baseBranch} -- reconcile them (pull), then settle`,
          );
        }
      }
    }

    // 3. Merge, in the base's own checkout or a temporary one.
    let temporary: string | null = null;
    if (!mergeDir) {
      temporary = join(sessionTreesOf(this.workspaceRoot, projectId), `.settle-${input.hash}`);
      await rm(temporary, { recursive: true, force: true });
      await this.git(projectId, ["worktree", "prune"]);
      await mkdir(dirname(temporary), { recursive: true });
      await this.git(projectId, ["worktree", "add", "--quiet", "--", temporary, baseBranch]);
      mergeDir = temporary;
    }

    let outcome: SettleOutcome;
    try {
      const before = (await this.#run(mergeDir, ["rev-parse", "HEAD"])).trim();
      let mergeError: unknown = null;
      try {
        await this.#run(mergeDir, [
          ...who,
          "merge",
          "--no-ff",
          "--no-verify",
          "--no-edit",
          "-m",
          `Merge session “${input.title}” (${branch}) into ${baseBranch}`,
          "--",
          branch,
        ]);
      } catch (error) {
        mergeError = error;
      }

      if (mergeError) {
        const conflicts = (await this.#run(mergeDir, ["diff", "--name-only", "--diff-filter=U"], { read: true }))
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        await this.#run(mergeDir, ["merge", "--abort"], { okExitCodes: [0, 128] });
        const after = (await this.#run(mergeDir, ["rev-parse", "HEAD"])).trim();
        if (after !== before || (await this.#refExists(mergeDir, "MERGE_HEAD"))) {
          throw new Error(`the merge into ${baseBranch} could not be aborted cleanly -- check the project checkout`);
        }
        outcome = {
          state: "failed",
          baseBranch,
          conflicts,
          error: conflicts.length
            ? `merging into ${baseBranch} conflicts in ${conflicts.length} file${conflicts.length === 1 ? "" : "s"}`
            : `could not merge into ${baseBranch}: ${describe(mergeError)}`,
        };
      } else {
        const mergeCommitSha = (await this.#run(mergeDir, ["rev-parse", "HEAD"])).trim();
        outcome = { state: "settled", baseBranch, mergeCommitSha, pushed: false, pushError: null, cleanupError: null };
      }
    } finally {
      if (temporary) {
        await this.git(projectId, ["worktree", "remove", "--force", "--", temporary], { okExitCodes: [0, 128] }).catch(
          () => {},
        );
        await rm(temporary, { recursive: true, force: true }).catch(() => {});
        await this.git(projectId, ["worktree", "prune"]).catch(() => {});
      }
    }

    if (outcome.state === "failed") return outcome;

    // 4. Cleanup: the merge stands whatever happens here.
    try {
      const merged = await this.#isAncestor(projectId, `refs/heads/${branch}`, `refs/heads/${baseBranch}`);
      if (input.tree) {
        await this.#removeWorktree(projectId, input.tree, input.deleteBranch && merged ? branch : null);
      } else if (input.deleteBranch && merged) {
        await this.git(projectId, ["branch", "-D", "--", branch], { okExitCodes: [0, 1] });
      }
    } catch (error) {
      outcome.cleanupError = describe(error);
    }

    if (input.autoPush && hasOrigin) {
      try {
        // A plain push of the one branch: never forced.
        await this.git(projectId, ["push", "--quiet", "origin", `refs/heads/${baseBranch}:refs/heads/${baseBranch}`], {
          token: input.token,
        });
        outcome.pushed = true;
      } catch (error) {
        outcome.pushError = describe(error);
      }
    }
    return outcome;
  }

  async #isAncestor(projectId: string, ancestor: string, of: string): Promise<boolean> {
    try {
      await this.git(projectId, ["merge-base", "--is-ancestor", ancestor, of], { read: true });
      return true;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return false;
      throw error;
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof GitError) return error.stderr.trim() || error.message;
  return error instanceof Error ? error.message : String(error);
}

const exists = (path: string) => stat(path).then(() => true, () => false);
