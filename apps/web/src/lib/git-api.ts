import type {
  GitBranchList,
  GitCommitDetail,
  GitCommitResult,
  GitConnectResult,
  GitDiff,
  GitDiffScope,
  GitLogPage,
  GitRemoteInfo,
  GitResolveStrategy,
  GitStatus,
  GitSyncResult,
} from "@ucch/protocol"

import { projectApiUrl, type ProjectTarget } from "./project-target"

/**
 * The project's repository, over the API.
 *
 * Thin calls to `/api/projects/{hash}/git/...`. Every mutation answers with
 * the fresh status, so the view swaps its state for the response rather than
 * asking again. Nothing is cached here.
 */

/** A failure the server explained, with the parts the view acts on. */
export class GitApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The project directory is not a repository at all. */
    readonly notRepo = false,
    /** The remote wants credentials the account has not given. */
    readonly needsToken = false,
  ) {
    super(message)
    this.name = "GitApiError"
  }
}

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
    notRepo?: boolean
    needsToken?: boolean
  }
  throw new GitApiError(body.error ?? fallback, response.status, body.notRepo ?? false, body.needsToken ?? false)
}

async function get<T>(hash: ProjectTarget, path: string, fallback: string): Promise<T> {
  const response = await fetch(projectApiUrl(hash, `git/${path}`), { credentials: "include" })
  if (!response.ok) await fail(response, fallback)
  return (await response.json()) as T
}

async function post<T>(hash: ProjectTarget, path: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetch(projectApiUrl(hash, `git/${path}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) await fail(response, fallback)
  return (await response.json()) as T
}

async function send<T>(hash: ProjectTarget, path: string, method: "PUT" | "DELETE", body: unknown, fallback: string): Promise<T> {
  const response = await fetch(projectApiUrl(hash, `git/${path}`), {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) await fail(response, fallback)
  return (await response.json()) as T
}

type Paths = string[] | "all"
const pathsBody = (paths: Paths) => (paths === "all" ? { all: true } : { paths })

export const fetchGitStatus = (hash: ProjectTarget) => get<GitStatus>(hash, "status", "Could not read the repository.")

export const fetchGitDiff = (hash: ProjectTarget, path: string, scope: GitDiffScope) =>
  get<GitDiff>(hash, `diff?path=${encodeURIComponent(path)}&scope=${scope}`, "Could not read the diff.")

export const fetchGitLog = (hash: ProjectTarget, skip = 0, limit = 50) =>
  get<GitLogPage>(hash, `log?skip=${skip}&limit=${limit}`, "Could not read the history.")

export const fetchGitCommit = (hash: ProjectTarget, sha: string) =>
  get<GitCommitDetail>(hash, `commits/${sha}`, "Could not read the commit.")

export const fetchGitCommitDiff = (hash: ProjectTarget, sha: string, path: string) =>
  get<GitDiff>(hash, `commits/${sha}/diff?path=${encodeURIComponent(path)}`, "Could not read the diff.")

export const fetchGitBranches = (hash: ProjectTarget) => get<GitBranchList>(hash, "branches", "Could not list branches.")

export const gitStage = (hash: ProjectTarget, paths: Paths) =>
  post<GitStatus>(hash, "stage", pathsBody(paths), "Could not stage the changes.")

export const gitUnstage = (hash: ProjectTarget, paths: Paths) =>
  post<GitStatus>(hash, "unstage", pathsBody(paths), "Could not unstage the changes.")

export const gitDiscard = (hash: ProjectTarget, paths: Paths) =>
  post<GitStatus>(hash, "discard", pathsBody(paths), "Could not discard the changes.")

export const gitCommit = (hash: ProjectTarget, summary: string, description?: string) =>
  post<GitCommitResult>(hash, "commit", { summary, description }, "Could not commit.")

export const gitCheckout = (hash: ProjectTarget, branch: string, remote = false) =>
  post<GitStatus>(hash, "checkout", { branch, remote }, "Could not switch branches.")

export const gitCreateBranch = (hash: ProjectTarget, name: string) =>
  post<GitStatus>(hash, "branches", { name }, "Could not create the branch.")

export const gitFetch = (hash: ProjectTarget, unshallow = false) =>
  post<GitStatus>(hash, "fetch", { unshallow }, "Could not fetch from origin.")

export const gitPull = (hash: ProjectTarget) => post<GitSyncResult>(hash, "pull", {}, "Could not pull from origin.")

export const gitPush = (hash: ProjectTarget) => post<GitStatus>(hash, "push", {}, "Could not push to origin.")

export const gitConnectRemote = (hash: ProjectTarget, url: string) =>
  post<GitConnectResult>(hash, "remote", { url }, "Could not connect the repository.")

export const fetchGitRemote = (hash: ProjectTarget) =>
  get<GitRemoteInfo>(hash, "remote", "Could not read the remote.")

export const gitSetRemote = (hash: ProjectTarget, url: string) =>
  send<GitRemoteInfo>(hash, "remote", "PUT", { url }, "Could not change the remote.")

export const gitRemoveRemote = (hash: ProjectTarget) =>
  send<GitRemoteInfo>(hash, "remote", "DELETE", undefined, "Could not remove the remote.")

export const gitResolve = (hash: ProjectTarget, path: string, strategy: GitResolveStrategy) =>
  post<GitStatus>(hash, "resolve", { path, strategy }, "Could not resolve the file.")

export const gitAbortMerge = (hash: ProjectTarget) => post<GitStatus>(hash, "merge/abort", {}, "Could not abort the merge.")
