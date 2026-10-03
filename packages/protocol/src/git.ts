import { z } from "zod";

/**
 * What the Git view and its routes say to each other.
 *
 * The shapes follow `git status --porcelain=v2` closely enough that the
 * server can translate without inventing state, and loosely enough that the
 * view does not need to know git's letters. Request bodies are here too so
 * the client and the route validate the same thing.
 */

/** One letter of a status entry: what happened to the file on that side. */
export const GitChange = z.enum(["A", "M", "D", "R", "T", "C", "U", "."]);
export type GitChange = z.infer<typeof GitChange>;

export const GitFileStatus = z.object({
  path: z.string(),
  /** Where a renamed or copied file came from. */
  origPath: z.string().optional(),
  /** The change between HEAD and the index; `.` when the index matches HEAD. */
  index: GitChange,
  /** The change between the index and the working tree; `.` when clean. */
  worktree: GitChange,
  untracked: z.boolean(),
  conflicted: z.boolean(),
  /** git's two-letter conflict kind (`UU`, `AA`, `DU`, ...) when conflicted. */
  conflictKind: z.string().optional(),
});
export type GitFileStatus = z.infer<typeof GitFileStatus>;

export const GitStatus = z.object({
  /** The current branch, or null when HEAD is detached. */
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number().int().min(0),
  behind: z.number().int().min(0),
  detached: z.boolean(),
  /** True until the first commit: `HEAD` names a branch that has no commits. */
  unborn: z.boolean(),
  isShallow: z.boolean(),
  mergeInProgress: z.boolean(),
  rebaseInProgress: z.boolean(),
  /** When `origin` was last contacted, as an ISO date, or null if never. */
  lastFetchedAt: z.string().nullable(),
  hasRemote: z.boolean(),
  files: z.array(GitFileStatus),
  /** Set when there were more changes than the list carries. */
  truncated: z.boolean(),
});
export type GitStatus = z.infer<typeof GitStatus>;

export const GitDiffScope = z.enum(["worktree", "index", "untracked"]);
export type GitDiffScope = z.infer<typeof GitDiffScope>;

export const GitDiff = z.union([
  z.object({
    conflict: z.literal(false),
    /** A unified diff as `git diff` prints it, or "" when nothing differs. */
    patch: z.string(),
    binary: z.boolean(),
    truncated: z.boolean(),
  }),
  z.object({
    conflict: z.literal(true),
    /** The working copy with its conflict markers, for the resolver to show. */
    content: z.string(),
    truncated: z.boolean(),
  }),
]);
export type GitDiff = z.infer<typeof GitDiff>;

export const GitCommit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  parents: z.array(z.string()),
  authorName: z.string(),
  authorEmail: z.string(),
  /** Author date, ISO 8601. */
  date: z.string(),
  subject: z.string(),
  body: z.string(),
});
export type GitCommit = z.infer<typeof GitCommit>;

export const GitLogPage = z.object({
  commits: z.array(GitCommit),
  hasMore: z.boolean(),
  isShallow: z.boolean(),
});
export type GitLogPage = z.infer<typeof GitLogPage>;

export const GitCommitFile = z.object({
  path: z.string(),
  origPath: z.string().optional(),
  status: GitChange,
});
export type GitCommitFile = z.infer<typeof GitCommitFile>;

export const GitCommitDetail = z.object({
  commit: GitCommit,
  files: z.array(GitCommitFile),
});
export type GitCommitDetail = z.infer<typeof GitCommitDetail>;

export const GitBranch = z.object({
  /** Short name: `main`, or `origin/main` for a remote branch. */
  name: z.string(),
  sha: z.string(),
  upstream: z.string().nullable(),
  /** Committer date of the tip, ISO 8601. */
  date: z.string(),
  current: z.boolean(),
});
export type GitBranch = z.infer<typeof GitBranch>;

export const GitBranchList = z.object({
  current: z.string().nullable(),
  local: z.array(GitBranch),
  remote: z.array(GitBranch),
});
export type GitBranchList = z.infer<typeof GitBranchList>;

/** The result of a commit: what was written and where. */
export const GitCommitResult = z.object({
  sha: z.string(),
  branch: z.string().nullable(),
  status: GitStatus,
});
export type GitCommitResult = z.infer<typeof GitCommitResult>;

/** What `pull` came back with: the tree may now hold conflicts to resolve. */
export const GitSyncResult = z.object({
  conflicts: z.boolean(),
  status: GitStatus,
});
export type GitSyncResult = z.infer<typeof GitSyncResult>;

/**
 * What connecting a remote came back with. The remote's branch has been
 * merged in when it had one, and that merge may be waiting on conflicts;
 * either way the push is left for the person to confirm.
 */
export const GitConnectResult = z.object({
  /** The remote branch merged into the current one, or null when the remote had nothing to merge. */
  mergedFrom: z.string().nullable(),
  conflicts: z.boolean(),
  status: GitStatus,
});
export type GitConnectResult = z.infer<typeof GitConnectResult>;

// ---- request bodies ------------------------------------------------------

/** A path list is bounded so one request cannot build a command line git chokes on. */
export const GIT_PATHS_MAX = 2000;
export const GIT_SUMMARY_MAX = 200;
export const GIT_DESCRIPTION_MAX = 5000;

const GitPath = z.string().min(1).max(4096);

export const GitPathsBody = z.union([
  z.object({ paths: z.array(GitPath).min(1).max(GIT_PATHS_MAX) }),
  z.object({ all: z.literal(true) }),
]);
export type GitPathsBody = z.infer<typeof GitPathsBody>;

export const GitCommitBody = z.object({
  summary: z.string().trim().min(1).max(GIT_SUMMARY_MAX),
  description: z.string().max(GIT_DESCRIPTION_MAX).optional(),
});
export type GitCommitBody = z.infer<typeof GitCommitBody>;

export const GitCheckoutBody = z.object({
  /** A local branch name, or `origin/<name>` with `remote: true`. */
  branch: z.string().min(1).max(255),
  remote: z.boolean().optional(),
});
export type GitCheckoutBody = z.infer<typeof GitCheckoutBody>;

export const GitCreateBranchBody = z.object({
  name: z.string().trim().min(1).max(255),
});
export type GitCreateBranchBody = z.infer<typeof GitCreateBranchBody>;

export const GitResolveStrategy = z.enum(["ours", "theirs", "mark"]);
export type GitResolveStrategy = z.infer<typeof GitResolveStrategy>;

export const GitResolveBody = z.object({
  path: GitPath,
  strategy: GitResolveStrategy,
});
export type GitResolveBody = z.infer<typeof GitResolveBody>;

export const GitFetchBody = z.object({
  /** Turn a `--depth 1` clone into the whole history. */
  unshallow: z.boolean().optional(),
});
export type GitFetchBody = z.infer<typeof GitFetchBody>;

export const GitRemoteBody = z.object({
  /** Where `origin` should point. The transport whitelist is the server's. */
  url: z.string().trim().min(1).max(2048),
});
export type GitRemoteBody = z.infer<typeof GitRemoteBody>;
