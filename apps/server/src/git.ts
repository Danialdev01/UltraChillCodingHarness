import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  normalizeWorkspacePath,
  type GitBranch,
  type GitBranchList,
  type GitChange,
  type GitCommit,
  type GitCommitDetail,
  type GitCommitFile,
  type GitDiff,
  type GitDiffScope,
  type GitFileStatus,
  type GitLogPage,
  type GitResolveStrategy,
  type GitStatus,
} from "@ucch/protocol";
import { PathError } from "./files.js";
import { GitError, runGit, safeRepoUrl } from "./git-exec.js";
import type { TreeTarget } from "./trees.js";

/** The most changed files a status carries; a vendored tree can have far more. */
const MAX_STATUS_FILES = 2000;
/** The most of a patch the view is shown; a generated file's diff is not read anyway. */
const MAX_PATCH_BYTES = 1024 * 1024;
/** The most paths a checkout or pull reports as changed. */
const MAX_CHANGED_PATHS = 500;
/** Talking to a remote is slower than anything local, and slow is not stuck. */
const REMOTE_TIMEOUT_MS = 120_000;

const SHA = /^[0-9a-f]{4,40}$/;

/** The commit fields `log` and `show` are asked for, NUL-separated, one record per RS. */
const LOG_FORMAT = "%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b%x1e";

export interface GitAuthor {
  name: string;
  email: string;
}

/** What a working-tree mutation touched, for the `file.changed` announcements. */
export interface GitChangedPath {
  path: string;
  change: "added" | "modified" | "deleted";
}

/** The caller named a ref, sha, or branch git will not accept. Reported as 400. */
export class GitRefError extends Error {}

/**
 * A project's repository, as the Git view sees it.
 *
 * Everything shells out to git rather than reading `.git` by hand: the
 * porcelain formats are stable, and a status that disagrees with what `git`
 * in the terminal says would be worse than a slow one. Mutations on one
 * project are queued behind each other because git takes `index.lock` and
 * the agent may be committing at the same moment a person clicks "stage".
 */
/** A project's checkout by id, or one session's worktree of it. */
export type GitTarget = TreeTarget;

export class GitService {
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly timeoutMs = 30_000,
  ) {}

  /**
   * The working tree a target names: a project's checkout by its id, or a
   * session's worktree, already resolved by the caller through `treeFor`.
   */
  dir(target: GitTarget): string {
    return typeof target === "string" ? join(this.workspaceRoot, target) : target.tree;
  }

  /** Whether the project directory is a repository at all. */
  async isRepo(projectId: GitTarget): Promise<boolean> {
    try {
      await runGit(["rev-parse", "--git-dir"], this.dir(projectId), this.timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Where `origin` points, or null when there is no remote. */
  async remoteUrl(projectId: GitTarget): Promise<string | null> {
    const out = await runGit(["remote", "get-url", "origin"], this.dir(projectId), this.timeoutMs, {
      okExitCodes: [0, 2, 128],
    });
    return out.trim() || null;
  }

  // ---- reading ----------------------------------------------------------

  async status(projectId: GitTarget): Promise<GitStatus> {
    const cwd = this.dir(projectId);
    const [raw, gitDir, shallow, remotes] = await Promise.all([
      this.#git(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]),
      this.#git(cwd, ["rev-parse", "--absolute-git-dir"]).then((s) => s.trim()),
      this.#git(cwd, ["rev-parse", "--is-shallow-repository"]).then((s) => s.trim() === "true"),
      this.#git(cwd, ["remote"]).then((s) => s.split("\n").filter(Boolean)),
    ]);
    const parsed = parseStatusV2(raw);
    const [fetchedAt, merging, rebasing] = await Promise.all([
      mtime(join(gitDir, "FETCH_HEAD")),
      exists(join(gitDir, "MERGE_HEAD")),
      exists(join(gitDir, "rebase-merge")).then((r) => r || exists(join(gitDir, "rebase-apply"))),
    ]);
    return {
      branch: parsed.detached ? null : parsed.branch,
      upstream: parsed.upstream,
      ahead: parsed.ahead,
      behind: parsed.behind,
      detached: parsed.detached,
      unborn: parsed.unborn,
      isShallow: shallow,
      mergeInProgress: merging,
      rebaseInProgress: rebasing,
      lastFetchedAt: fetchedAt,
      hasRemote: remotes.includes("origin"),
      files: parsed.files.slice(0, MAX_STATUS_FILES),
      truncated: parsed.files.length > MAX_STATUS_FILES,
    };
  }

  /**
   * How many commits HEAD has that `base` does not: what a session has
   * committed since it forked. 0 for an unborn branch or a base git no
   * longer knows, so a session is never held back by a ref it cannot read.
   */
  async commitsSince(projectId: GitTarget, base: string): Promise<number> {
    const cwd = this.dir(projectId);
    const out = await this.#git(cwd, ["rev-list", "--count", `${this.#refName(base)}..HEAD`, "--"], {
      okExitCodes: [0, 128],
    });
    const count = Number.parseInt(out.trim(), 10);
    return Number.isFinite(count) ? count : 0;
  }

  async diff(projectId: GitTarget, path: string, scope: GitDiffScope): Promise<GitDiff> {
    const cwd = this.dir(projectId);
    const rel = this.#path(path);
    if (scope === "untracked") {
      const patch = await this.#git(
        cwd,
        ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", "/dev/null", rel],
        { okExitCodes: [0, 1] },
      );
      return patchResult(patch);
    }
    if (scope === "worktree") {
      // A file mid-conflict has markers in the working copy; the diff against
      // the index is noise, and the resolver wants the copy itself.
      const conflicted = await this.#git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z", "--", rel]);
      if (conflicted.length > 0) {
        const content = await readFile(join(cwd, rel), "utf8");
        return {
          conflict: true,
          content: content.slice(0, MAX_PATCH_BYTES),
          truncated: content.length > MAX_PATCH_BYTES,
        };
      }
    }
    const args = ["diff", "--no-color", "--no-ext-diff", "-U3", "-M"];
    if (scope === "index") args.push("--cached");
    const patch = await this.#git(cwd, [...args, "--", rel]);
    return patchResult(patch);
  }

  async log(projectId: GitTarget, options: { skip?: number; limit?: number } = {}): Promise<GitLogPage> {
    const cwd = this.dir(projectId);
    const skip = Math.max(0, options.skip ?? 0);
    const limit = Math.min(100, Math.max(1, options.limit ?? 50));
    const shallow = (await this.#git(cwd, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
    let out: string;
    try {
      out = await this.#git(cwd, [
        "log",
        `--format=${LOG_FORMAT}`,
        `--skip=${skip}`,
        `-n${limit + 1}`,
      ]);
    } catch (error) {
      // A branch with no commits yet is not an error, it is an empty page.
      if (error instanceof GitError && /does not have any commits|bad default revision/i.test(error.stderr)) {
        return { commits: [], hasMore: false, isShallow: shallow };
      }
      throw error;
    }
    const commits = parseLog(out);
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit, isShallow: shallow };
  }

  async show(projectId: GitTarget, sha: string): Promise<GitCommitDetail> {
    const cwd = this.dir(projectId);
    const ref = this.#sha(sha);
    const meta = await this.#git(cwd, ["show", "-s", `--format=${LOG_FORMAT}`, ref, "--"]);
    const [commit] = parseLog(meta);
    if (!commit) throw new GitRefError(`unknown commit: ${sha}`);
    const names = await this.#git(cwd, [
      "diff-tree",
      "-r",
      "-M",
      "-z",
      "--name-status",
      "--no-commit-id",
      ...revisionRange(commit),
      "--",
    ]);
    return { commit, files: parseNameStatusZ(names) };
  }

  async commitDiff(projectId: GitTarget, sha: string, path: string): Promise<GitDiff> {
    const cwd = this.dir(projectId);
    const ref = this.#sha(sha);
    const rel = this.#path(path);
    const [commit] = parseLog(await this.#git(cwd, ["show", "-s", `--format=${LOG_FORMAT}`, ref, "--"]));
    if (!commit) throw new GitRefError(`unknown commit: ${sha}`);
    const patch = await this.#git(cwd, [
      "diff-tree",
      "-p",
      "-M",
      "-U3",
      "--no-color",
      "--no-ext-diff",
      "--no-commit-id",
      ...revisionRange(commit),
      "--",
      rel,
    ]);
    return patchResult(patch);
  }

  async branches(projectId: GitTarget): Promise<GitBranchList> {
    const cwd = this.dir(projectId);
    const out = await this.#git(cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname:short)%00%(upstream:short)%00%(committerdate:iso-strict)%00%(HEAD)",
      "--sort=-committerdate",
      "refs/heads",
      "refs/remotes",
    ]);
    return parseForEachRef(out);
  }

  // ---- the index and working tree ---------------------------------------

  stage(projectId: GitTarget, paths: string[] | "all"): Promise<void> {
    return this.#serial(projectId, async (cwd) => {
      if (paths === "all") await this.#git(cwd, ["add", "-A"]);
      else await this.#git(cwd, ["add", "-A", "--", ...this.#paths(paths)]);
    });
  }

  unstage(projectId: GitTarget, paths: string[] | "all"): Promise<void> {
    return this.#serial(projectId, async (cwd) => {
      const rel = paths === "all" ? [] : this.#paths(paths);
      if (await this.#hasHead(cwd)) {
        await this.#git(cwd, ["reset", "-q", "--", ...rel]);
      } else {
        // Nothing to reset the index back to before the first commit; the
        // entries themselves have to go.
        await this.#git(cwd, ["rm", "--cached", "-r", "-q", ...(rel.length ? ["--", ...rel] : ["--", "."])]);
      }
    });
  }

  /**
   * Throws away changes: tracked files go back to HEAD, untracked ones are
   * deleted. `all` means every changed file in the status.
   */
  discard(projectId: GitTarget, paths: string[] | "all"): Promise<GitChangedPath[]> {
    return this.#serial(projectId, async (cwd) => {
      const status = parseStatusV2(
        await this.#git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      );
      const wanted = paths === "all" ? null : new Set(this.#paths(paths));
      const files = status.files.filter((f) => !wanted || wanted.has(f.path));
      const untracked = files.filter((f) => f.untracked).map((f) => f.path);
      const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
      const hasHead = await this.#hasHead(cwd);
      if (tracked.length > 0) {
        if (hasHead) {
          await this.#git(cwd, ["restore", "--staged", "--worktree", "--source=HEAD", "--", ...tracked]);
        } else {
          await this.#git(cwd, ["rm", "--cached", "-r", "-q", "--", ...tracked]);
        }
      }
      if (untracked.length > 0) await this.#git(cwd, ["clean", "-f", "--", ...untracked]);
      // A file added since HEAD is gone once restored; `restore` deletes it.
      return files.map((f) => ({
        path: f.path,
        change: f.untracked || (f.index === "A" && hasHead) || !hasHead ? "deleted" : "modified",
      }));
    });
  }

  commit(
    projectId: GitTarget,
    message: { summary: string; description?: string },
    author: GitAuthor,
  ): Promise<{ sha: string; branch: string | null }> {
    return this.#serial(projectId, async (cwd) => {
      const args = [
        // Passed as config rather than set in the repository: the identity
        // belongs to this commit, and the agent's own commits resolve it the
        // same way rather than inheriting a name from here.
        ...identity(author),
        "commit",
        "--no-verify",
        "-m",
        message.summary,
      ];
      if (message.description?.trim()) args.push("-m", message.description.trim());
      await this.#git(cwd, args);
      const sha = (await this.#git(cwd, ["rev-parse", "HEAD"])).trim();
      const branch = (await this.#git(cwd, ["branch", "--show-current"])).trim() || null;
      return { sha, branch };
    });
  }

  // ---- branches ---------------------------------------------------------

  /**
   * Switches branches. A remote branch (`origin/x`) gets a local `x`
   * tracking it, or is simply switched to when `x` already exists.
   */
  checkout(projectId: GitTarget, branch: string, remote = false): Promise<GitChangedPath[]> {
    return this.#serial(projectId, async (cwd) => {
      const before = await this.#head(cwd);
      if (remote) {
        const local = branch.replace(/^[^/]+\//, "");
        this.#branchName(local);
        const have = await this.#git(cwd, ["branch", "--list", "--", local]);
        if (have.trim()) await this.#git(cwd, ["switch", "--", local]);
        else await this.#git(cwd, ["switch", "--track", "-c", local, `${this.#refName(branch)}`]);
      } else {
        await this.#git(cwd, ["switch", "--", this.#branchName(branch)]);
      }
      return this.#changedBetween(cwd, before, await this.#head(cwd));
    });
  }

  createBranch(projectId: GitTarget, name: string): Promise<void> {
    return this.#serial(projectId, async (cwd) => {
      await this.#git(cwd, ["switch", "-c", this.#branchName(name)]);
    });
  }

  // ---- the remote -------------------------------------------------------

  fetch(projectId: GitTarget, token: string | null, options: { unshallow?: boolean } = {}): Promise<void> {
    return this.#serial(projectId, async (cwd) => {
      await this.#widenRefspec(cwd);
      const args = ["fetch", "--prune", "origin"];
      if (options.unshallow) {
        const shallow = (await this.#git(cwd, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
        if (shallow) args.push("--unshallow");
      }
      await this.#git(cwd, args, { token, timeoutMs: REMOTE_TIMEOUT_MS });
    });
  }

  /**
   * Merges the upstream in. A conflict is an outcome, not a failure: git
   * exits 1, the tree holds the markers, and the caller shows the resolver.
   */
  pull(
    projectId: GitTarget,
    token: string | null,
    author: GitAuthor,
  ): Promise<{ conflicts: boolean; changed: GitChangedPath[] }> {
    return this.#serial(projectId, async (cwd) => {
      await this.#widenRefspec(cwd);
      const before = await this.#head(cwd);
      // A pull that has to merge writes a commit, and a commit needs a name.
      const out = await this.#git(cwd, [...identity(author), "pull", "--no-rebase", "origin"], {
        token,
        timeoutMs: REMOTE_TIMEOUT_MS,
        okExitCodes: [0, 1],
      });
      const conflicts = /CONFLICT|Automatic merge failed/i.test(out) || (await this.#conflicted(cwd));
      const changed = await this.#changedBetween(cwd, before, await this.#head(cwd));
      return { conflicts, changed };
    });
  }

  /** Pushes the current branch, publishing it when it has no upstream yet. */
  push(projectId: GitTarget, token: string | null): Promise<{ branch: string; remoteSha: string }> {
    return this.#serial(projectId, async (cwd) => {
      await this.#widenRefspec(cwd);
      const branch = (await this.#git(cwd, ["branch", "--show-current"])).trim();
      if (!branch) throw new GitRefError("cannot push a detached HEAD");
      const upstream = await this.#git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
        okExitCodes: [0, 128],
      });
      const args = upstream.trim() ? ["push", "origin", `HEAD:refs/heads/${branch}`] : ["push", "-u", "origin", branch];
      await this.#git(cwd, args, { token, timeoutMs: REMOTE_TIMEOUT_MS });
      const remoteSha = (await this.#git(cwd, ["rev-parse", `refs/remotes/origin/${branch}`])).trim();
      return { branch, remoteSha };
    });
  }

  /**
   * Points `origin` at a repository and brings what is there in.
   *
   * The remote is added, fetched, and its branch merged into the current one
   * -- the same-named branch when it has one, the remote's default otherwise
   * -- so the two histories meet here, where conflicts can be resolved,
   * rather than in a push the remote refuses. `--allow-unrelated-histories`
   * because a project started here and a repository started on GitHub share
   * no commit, and that is the whole point of connecting them. An unborn
   * branch simply takes the remote's tree. A merge that conflicts is an
   * outcome, as in `pull`; a fetch that fails takes the remote away again so
   * a typo does not leave `origin` pointing at nothing.
   */
  connectRemote(
    projectId: GitTarget,
    url: string,
    token: string | null,
    author: GitAuthor,
  ): Promise<{ mergedFrom: string | null; conflicts: boolean; changed: GitChangedPath[] }> {
    return this.#serial(projectId, async (cwd) => {
      const safe = safeRepoUrl(url);
      await this.#git(cwd, ["remote", "add", "origin", "--", safe]);
      try {
        await this.#git(cwd, ["fetch", "--prune", "origin"], { token, timeoutMs: REMOTE_TIMEOUT_MS });
        // `origin/HEAD` is only written by a clone; asked for here so a
        // remote whose default branch is not ours can still be merged.
        await this.#git(cwd, ["remote", "set-head", "origin", "--auto"], { token, timeoutMs: REMOTE_TIMEOUT_MS, okExitCodes: [0, 1, 128] });
      } catch (error) {
        await this.#git(cwd, ["remote", "remove", "origin"]).catch(() => {});
        throw error;
      }
      const branch = (await this.#git(cwd, ["branch", "--show-current"])).trim();
      if (!branch) return { mergedFrom: null, conflicts: false, changed: [] };
      const target = await this.#remoteBranchFor(cwd, branch);
      if (!target) return { mergedFrom: null, conflicts: false, changed: [] };
      const before = await this.#head(cwd);
      const out = await this.#git(
        cwd,
        [...identity(author), "merge", "--no-edit", "--allow-unrelated-histories", "--", target],
        { okExitCodes: [0, 1] },
      );
      const conflicts = /CONFLICT|Automatic merge failed/i.test(out) || (await this.#conflicted(cwd));
      // Tracking is set once the histories are joined, so the toolbar's push
      // and pull know where to go. A default branch under another name is
      // merged but not tracked: the push will publish ours beside it.
      if (target === `origin/${branch}`) {
        await this.#git(cwd, ["branch", `--set-upstream-to=${target}`, branch]);
      }
      const changed = await this.#changedBetween(cwd, before, await this.#head(cwd));
      return { mergedFrom: target, conflicts, changed };
    });
  }

  /**
   * Points an existing `origin` somewhere else. Nothing is fetched or
   * merged: the history stays as it is, and the next fetch or push is what
   * talks to the new address.
   */
  setRemoteUrl(projectId: GitTarget, url: string): Promise<void> {
    return this.#serial(projectId, async (cwd) => {
      await this.#git(cwd, ["remote", "set-url", "origin", "--", safeRepoUrl(url)]);
    });
  }

  /** Forgets `origin`, and with it every remote-tracking branch. Local commits stay. */
  removeRemote(projectId: GitTarget): Promise<void> {
    return this.#serial(projectId, async (cwd) => {
      await this.#git(cwd, ["remote", "remove", "origin"]);
    });
  }

  // ---- conflicts --------------------------------------------------------

  resolve(projectId: GitTarget, path: string, strategy: GitResolveStrategy): Promise<void> {
    return this.#serial(projectId, async (cwd) => {
      const rel = this.#path(path);
      if (strategy !== "mark") {
        await this.#git(cwd, ["checkout", `--${strategy}`, "--", rel]);
      }
      await this.#git(cwd, ["add", "--", rel]);
    });
  }

  abortMerge(projectId: GitTarget): Promise<GitChangedPath[]> {
    return this.#serial(projectId, async (cwd) => {
      const gitDir = (await this.#git(cwd, ["rev-parse", "--absolute-git-dir"])).trim();
      const changedBefore = parseStatusV2(
        await this.#git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      ).files.map((f) => f.path);
      if ((await exists(join(gitDir, "rebase-merge"))) || (await exists(join(gitDir, "rebase-apply")))) {
        await this.#git(cwd, ["rebase", "--abort"]);
      } else {
        await this.#git(cwd, ["merge", "--abort"]);
      }
      return changedBefore.slice(0, MAX_CHANGED_PATHS).map((path) => ({ path, change: "modified" as const }));
    });
  }

  // ---- internals --------------------------------------------------------

  #git(
    cwd: string,
    argv: string[],
    options: { token?: string | null; okExitCodes?: readonly number[]; timeoutMs?: number } = {},
  ): Promise<string> {
    return runGit(argv, cwd, options.timeoutMs ?? this.timeoutMs, {
      token: options.token,
      okExitCodes: options.okExitCodes,
    });
  }

  /** Runs one mutation after any other in flight for the same project. */
  #serial<T>(projectId: GitTarget, work: (cwd: string) => Promise<T>): Promise<T> {
    // Keyed by tree: each worktree has an index (and `index.lock`) of its own.
    const cwd = this.dir(projectId);
    const previous = this.#chains.get(cwd) ?? Promise.resolve();
    const next = previous.then(
      () => work(cwd),
      () => work(cwd),
    );
    this.#chains.set(cwd, next);
    next.finally(() => {
      if (this.#chains.get(cwd) === next) this.#chains.delete(cwd);
    }).catch(() => {});
    return next;
  }

  #path(path: string): string {
    if (isAbsolute(path)) throw new PathError(`path must be relative: ${path}`);
    const normalized = normalizeWorkspacePath(path);
    if (normalized === null || normalized === "") throw new PathError(`path escapes the workspace: ${path}`);
    return normalized;
  }

  #paths(paths: string[]): string[] {
    return paths.map((p) => this.#path(p));
  }

  #sha(sha: string): string {
    if (!SHA.test(sha)) throw new GitRefError(`not a commit id: ${sha}`);
    return sha;
  }

  /** A branch name git would accept, and one that cannot be read as an option. */
  #branchName(name: string): string {
    if (name.startsWith("-") || name.includes("\0") || !/^[^\s~^:?*[\\]+$/.test(name) || name.includes("..")) {
      throw new GitRefError(`not a valid branch name: ${name}`);
    }
    return name;
  }

  #refName(name: string): string {
    return this.#branchName(name);
  }

  /**
   * A `--depth 1` clone is also a single-branch clone: its fetch refspec
   * names the one branch, so no other branch of the remote ever appears and
   * a published branch gets no remote-tracking ref. Widened once, before
   * anything talks to the remote; a no-op on a repository that is already
   * fetching everything.
   */
  async #widenRefspec(cwd: string): Promise<void> {
    const current = await this.#git(cwd, ["config", "--get-all", "remote.origin.fetch"], { okExitCodes: [0, 1] });
    const wanted = "+refs/heads/*:refs/remotes/origin/*";
    if (!current.trim()) return; // no origin at all; the remote command will say so
    if (current.split("\n").includes(wanted)) return;
    await this.#git(cwd, ["config", "remote.origin.fetch", wanted]);
  }

  /** `origin/<branch>` when the remote has it, else the remote's default branch, else null. */
  async #remoteBranchFor(cwd: string, branch: string): Promise<string | null> {
    const same = await this.#git(cwd, ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`], {
      okExitCodes: [0, 1],
    });
    if (same.trim()) return `origin/${branch}`;
    const head = await this.#git(cwd, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { okExitCodes: [0, 1] });
    const name = head.trim().replace(/^refs\/remotes\//, "");
    return name || null;
  }

  async #hasHead(cwd: string): Promise<boolean> {
    const out = await this.#git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { okExitCodes: [0, 1] });
    return out.trim().length > 0;
  }

  async #head(cwd: string): Promise<string | null> {
    const out = await this.#git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { okExitCodes: [0, 1] });
    return out.trim() || null;
  }

  async #conflicted(cwd: string): Promise<boolean> {
    const out = await this.#git(cwd, ["diff", "--name-only", "--diff-filter=U", "-z"]);
    return out.length > 0;
  }

  /** Every path that differs between two commits, as the tree changed. */
  async #changedBetween(cwd: string, before: string | null, after: string | null): Promise<GitChangedPath[]> {
    if (!before || !after || before === after) return [];
    const out = await this.#git(cwd, ["diff", "--name-status", "-z", "-M", before, after, "--"]);
    return parseNameStatusZ(out)
      .slice(0, MAX_CHANGED_PATHS)
      .map((f) => ({
        path: f.path,
        change: f.status === "A" ? "added" : f.status === "D" ? "deleted" : "modified",
      }));
  }
}

// ---- parsers ----------------------------------------------------------------

export interface ParsedStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  unborn: boolean;
  files: GitFileStatus[];
}

/**
 * Reads `git status --porcelain=v2 --branch -z`.
 *
 * Every record ends in NUL; a rename (`2`) has a second NUL-terminated field
 * carrying the original path, which is why records cannot simply be split on
 * NUL and read one at a time.
 */
export function parseStatusV2(raw: string): ParsedStatus {
  const result: ParsedStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    detached: false,
    unborn: false,
    files: [],
  };
  const parts = raw.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]!;
    if (line === "") continue;
    if (line.startsWith("# ")) {
      const [key, ...rest] = line.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") result.unborn = value === "(initial)";
      else if (key === "branch.head") {
        if (value === "(detached)") result.detached = true;
        else result.branch = value;
      } else if (key === "branch.upstream") result.upstream = value;
      else if (key === "branch.ab") {
        const m = /\+(\d+) -(\d+)/.exec(value);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = line[0];
    if (kind === "?") {
      result.files.push({
        path: line.slice(2),
        index: ".",
        worktree: ".",
        untracked: true,
        conflicted: false,
      });
      continue;
    }
    if (kind === "!") continue;
    if (kind === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      const path = fields.slice(8).join(" ");
      result.files.push({
        path,
        index: change(xy[0]),
        worktree: change(xy[1]),
        untracked: false,
        conflicted: false,
      });
      continue;
    }
    if (kind === "2") {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
      const fields = line.split(" ");
      const xy = fields[1] ?? "..";
      const path = fields.slice(9).join(" ");
      const origPath = parts[++i] ?? "";
      result.files.push({
        path,
        origPath,
        index: change(xy[0]),
        worktree: change(xy[1]),
        untracked: false,
        conflicted: false,
      });
      continue;
    }
    if (kind === "u") {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const fields = line.split(" ");
      const xy = fields[1] ?? "UU";
      const path = fields.slice(10).join(" ");
      result.files.push({
        path,
        index: "U",
        worktree: "U",
        untracked: false,
        conflicted: true,
        conflictKind: xy,
      });
    }
  }
  return result;
}

function change(letter: string | undefined): GitChange {
  switch (letter) {
    case "A":
    case "M":
    case "D":
    case "R":
    case "T":
    case "C":
    case "U":
      return letter;
    default:
      return ".";
  }
}

/** Reads the `LOG_FORMAT` records `log` and `show` print. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of out.split("\x1e")) {
    const trimmed = record.replace(/^\n/, "");
    if (!trimmed.trim()) continue;
    const [sha, shortSha, parents, authorName, authorEmail, date, subject, ...rest] = trimmed.split("\0");
    if (!sha || !shortSha) continue;
    commits.push({
      sha,
      shortSha,
      parents: (parents ?? "").split(" ").filter(Boolean),
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      date: date ?? "",
      subject: subject ?? "",
      body: rest.join("\0").replace(/\n+$/, ""),
    });
  }
  return commits;
}

/** Reads `for-each-ref` over `refs/heads` and `refs/remotes`. */
export function parseForEachRef(out: string): GitBranchList {
  const local: GitBranch[] = [];
  const remote: GitBranch[] = [];
  let current: string | null = null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [refname, sha, upstream, date, head] = line.split("\0");
    if (!refname || !sha) continue;
    const isCurrent = head === "*";
    if (refname.startsWith("refs/heads/")) {
      const name = refname.slice("refs/heads/".length);
      if (isCurrent) current = name;
      local.push({ name, sha, upstream: upstream || null, date: date ?? "", current: isCurrent });
    } else if (refname.startsWith("refs/remotes/")) {
      const name = refname.slice("refs/remotes/".length);
      // `origin/HEAD` is a pointer at the default branch, not a branch.
      if (name.endsWith("/HEAD")) continue;
      remote.push({ name, sha, upstream: null, date: date ?? "", current: false });
    }
  }
  return { current, local, remote };
}

/** Reads `--name-status -z`: a status, a path, and for renames the new path too. */
export function parseNameStatusZ(out: string): GitCommitFile[] {
  const parts = out.split("\0");
  const files: GitCommitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!;
    if (!status) continue;
    const letter = change(status[0]);
    if (letter === "R" || letter === "C") {
      const origPath = parts[++i] ?? "";
      const path = parts[++i] ?? "";
      files.push({ path, origPath, status: letter });
    } else {
      files.push({ path: parts[++i] ?? "", status: letter });
    }
  }
  return files;
}

/**
 * What a commit is compared against: its first parent, or nothing for the
 * first commit. Spelled out because `diff-tree <merge>` on its own prints no
 * diff at all -- git wants to be told which side of a merge to look from,
 * and the first parent is the side every hosting UI shows.
 */
function revisionRange(commit: GitCommit): string[] {
  const parent = commit.parents[0];
  return parent ? [parent, commit.sha] : ["--root", commit.sha];
}

function identity(author: GitAuthor): string[] {
  return ["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`];
}

function patchResult(patch: string): GitDiff {
  const binary = /^Binary files .* differ$/m.test(patch) || patch.includes("GIT binary patch");
  return {
    conflict: false,
    patch: binary ? "" : patch.slice(0, MAX_PATCH_BYTES),
    binary,
    truncated: !binary && patch.length > MAX_PATCH_BYTES,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function mtime(path: string): Promise<string | null> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
}
