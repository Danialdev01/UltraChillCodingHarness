"use client"

import * as React from "react"
import type { GitBranchList, GitCommitDetail, GitDiff, GitLogPage, GitStatus } from "@ucch/protocol"

import { useQuery, useQueryClient } from "@tanstack/react-query"

import { qk } from "@/lib/query-keys"
import { useProjectEvents } from "@/lib/realtime"
import {
  GitApiError,
  fetchGitBranches,
  fetchGitCommit,
  fetchGitCommitDiff,
  fetchGitDiff,
  fetchGitLog,
  fetchGitStatus,
} from "@/lib/git-api"
import { targetOf } from "@/lib/project-target"
import type { Project } from "@/lib/session"

/** What the main pane is showing: a working-tree change, or a file of a commit. */
export type GitSelection =
  | { kind: "change"; path: string; scope: "worktree" | "index" | "untracked" }
  | { kind: "commit"; sha: string; path: string | null }

export interface GitState {
  status: GitStatus | null
  branches: GitBranchList | null
  log: GitLogPage | null
  /** The commits shown so far; `log.commits` is only the latest page. */
  commits: GitLogPage["commits"]
  selection: GitSelection | null
  diff: GitDiff | null
  commit: GitCommitDetail | null
  diffLoading: boolean
  /** Set while a mutation is in flight; the toolbar and lists disable themselves. */
  busy: string | null
  error: string | null
  /** The project directory is not a repository at all. */
  notRepo: boolean
  loading: boolean
  select(selection: GitSelection | null): void
  refresh(): Promise<void>
  loadMoreHistory(): Promise<void>
  /**
   * Runs a mutation. The result is either a status or something that carries
   * one; either way the view swaps to it and re-reads whatever else the change
   * could have moved.
   */
  mutate<T extends GitStatus | { status: GitStatus }>(label: string, work: () => Promise<T>): Promise<T | null>
  clearError(): void
}

/** The pages of history read past the first, and which first page they follow. */
interface OlderHistory {
  after: GitLogPage
  commits: GitLogPage["commits"]
  last: GitLogPage
}

/**
 * The Git view's state.
 *
 * The status, the branches and the first page of history are queries that
 * never go stale by time: the server says when they have (`realtime-cache.ts`
 * invalidates `qk.git.all` on `resource.changed{git}`, `git.committed` and
 * `git.pushed`), once per burst of changes and for every viewer of the
 * tree, whoever made them -- this tab, the agent, a terminal -- and the
 * view reads them again when it opens. The server answers a read nothing
 * changed with a 304. Nothing polls.
 */
export function useGitState(project: Project): GitState {
  const { id: projectId } = project
  // A project session's worktree when the page is one's: each session is
  // its own branch, with its own status and history.
  const projectHash = project.hash
  const sessionHash = project.sessionHash ?? null
  const hash = React.useMemo(() => targetOf({ hash: projectHash, sessionHash }), [projectHash, sessionHash])
  const queryClient = useQueryClient()
  const statusKey = qk.git.read("status", projectHash, sessionHash)
  const branchesKey = qk.git.read("branches", projectHash, sessionHash)
  const logKey = qk.git.read("log", projectHash, sessionHash)
  // Never stale by time, but read again on opening the view: what changed
  // while it was closed was not necessarily heard.
  const live = { staleTime: Infinity, refetchOnMount: "always", refetchOnWindowFocus: false, retry: false } as const
  const statusQuery = useQuery({ queryKey: statusKey, queryFn: () => fetchGitStatus(hash), ...live })
  const branchesQuery = useQuery({ queryKey: branchesKey, queryFn: () => fetchGitBranches(hash), ...live })
  const logQuery = useQuery({ queryKey: logKey, queryFn: () => fetchGitLog(hash, 0, 50), ...live })
  const status = statusQuery.data ?? null
  const branches = branchesQuery.data ?? null
  const log0 = logQuery.data ?? null

  const [older, setOlder] = React.useState<OlderHistory | null>(null)
  // Pages read past the first belong to the history they continued; a new
  // first page -- a commit, a checkout -- starts the list again.
  const more = older && older.after === log0 ? older : null
  const log = more?.last ?? log0
  const commits = React.useMemo(
    () => (log0 ? (more ? [...log0.commits, ...more.commits] : log0.commits) : []),
    [log0, more],
  )

  const [selection, setSelection] = React.useState<GitSelection | null>(null)
  const [diff, setDiff] = React.useState<GitDiff | null>(null)
  const [commit, setCommit] = React.useState<GitCommitDetail | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [localError, setLocalError] = React.useState<string | null>(null)
  // A failed read stays failed until it is read again; dismissing it hides that one failure.
  const [dismissed, setDismissed] = React.useState<unknown>(null)

  const readError = statusQuery.error ?? branchesQuery.error ?? logQuery.error
  const notRepo = readError instanceof GitApiError && readError.notRepo
  const error =
    localError ??
    (readError && !notRepo && readError !== dismissed
      ? readError instanceof Error
        ? readError.message
        : "Could not read the repository."
      : null)
  const loading = statusQuery.isPending && !readError

  const refresh = React.useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: qk.git.read("status", projectHash, sessionHash) })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.git.read("branches", projectHash, sessionHash) }),
      queryClient.invalidateQueries({ queryKey: qk.git.read("log", projectHash, sessionHash) }),
    ])
  }, [queryClient, projectHash, sessionHash])

  // The diff on screen is read again when its file changes: its entry in the
  // status moves (staged, committed, reverted), or the file itself is
  // written again in this tree while it stays modified.
  const [diffRev, setDiffRev] = React.useState(0)
  const selectionRef = React.useRef(selection)
  selectionRef.current = selection
  // With files: the server watches this tree and its repository for as long
  // as the view is open, so a commit or a checkout typed in a terminal
  // reaches it too, as a git invalidation.
  useProjectEvents(
    projectId,
    (event) => {
      if (event.type !== "file.changed" || (event.worktreeId ?? null) !== sessionHash) return
      const current = selectionRef.current
      if (current?.kind === "change" && current.path === event.path) setDiffRev((n) => n + 1)
    },
    { files: true, tree: sessionHash },
  )

  // The diff follows the selection. Keyed on its parts rather than the
  // object so a status that rebuilds the same selection does not refetch.
  const selKind = selection?.kind ?? null
  const selPath = selection?.path ?? null
  const selScope = selection?.kind === "change" ? selection.scope : null
  const selSha = selection?.kind === "commit" ? selection.sha : null
  React.useEffect(() => {
    if (!selKind) {
      setDiff(null)
      setCommit(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    const work =
      selKind === "change"
        ? fetchGitDiff(hash, selPath!, selScope!).then((d) => {
            if (!cancelled) {
              setDiff(d)
              setCommit(null)
            }
          })
        : Promise.all([
            fetchGitCommit(hash, selSha!),
            selPath ? fetchGitCommitDiff(hash, selSha!, selPath) : Promise.resolve(null),
          ]).then(([detail, d]) => {
            if (!cancelled) {
              setCommit(detail)
              setDiff(d)
            }
          })
    work
      .catch((caught) => {
        if (!cancelled) setLocalError(caught instanceof Error ? caught.message : "Could not read the diff.")
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hash, selKind, selPath, selScope, selSha, diffRev])

  // When the status changes under a selected change, the selection may no
  // longer exist (the file was committed) or its scope may have moved (it
  // was staged). Follow it, or drop it; and when only its entry changed,
  // read its diff again.
  const selectedEntry = React.useMemo(() => {
    if (!status || selKind !== "change") return undefined
    const file = status.files.find((f) => f.path === selPath)
    return file ? entryOf(file) : null
  }, [status, selKind, selPath])
  const lastEntry = React.useRef(selectedEntry)
  React.useEffect(() => {
    const previous = lastEntry.current
    lastEntry.current = selectedEntry
    const current = selectionRef.current
    if (!status || !current || current.kind !== "change") return
    const file = status.files.find((f) => f.path === current.path)
    if (!file) {
      setSelection(null)
      return
    }
    const scope = scopeFor(file)
    if (scope !== current.scope) setSelection({ kind: "change", path: current.path, scope })
    else if (previous !== undefined && previous !== selectedEntry) setDiffRev((n) => n + 1)
  }, [status, selectedEntry])

  const mutate = React.useCallback(
    async <T extends GitStatus | { status: GitStatus }>(label: string, work: () => Promise<T>): Promise<T | null> => {
      setBusy(label)
      setLocalError(null)
      try {
        const result = await work()
        queryClient.setQueryData(qk.git.read("status", projectHash, sessionHash), "status" in result ? result.status : result)
        // Branches and history can both have moved; the status alone does not say.
        void queryClient.invalidateQueries({ queryKey: qk.git.read("branches", projectHash, sessionHash) })
        void queryClient.invalidateQueries({ queryKey: qk.git.read("log", projectHash, sessionHash) })
        return result
      } catch (caught) {
        setLocalError(caught instanceof Error ? caught.message : `Could not ${label.toLowerCase()}.`)
        return null
      } finally {
        setBusy(null)
      }
    },
    [queryClient, projectHash, sessionHash],
  )

  const loadMoreHistory = React.useCallback(async () => {
    if (!log0 || !log?.hasMore) return
    try {
      const page = await fetchGitLog(hash, commits.length, 50)
      setOlder((prev) => {
        const base = prev && prev.after === log0 ? prev.commits : []
        return { after: log0, commits: [...base, ...page.commits], last: page }
      })
    } catch (caught) {
      setLocalError(caught instanceof Error ? caught.message : "Could not read more history.")
    }
  }, [hash, log0, log?.hasMore, commits.length])

  return {
    status,
    branches,
    log,
    commits,
    selection,
    diff,
    commit,
    diffLoading,
    busy,
    error,
    notRepo,
    loading,
    select: setSelection,
    refresh,
    loadMoreHistory,
    mutate,
    clearError: () => {
      setLocalError(null)
      setDismissed(readError)
    },
  }
}

/** A file's entry in the status, as one comparable string. */
function entryOf(file: GitStatus["files"][number]): string {
  return `${file.index}${file.worktree}${file.untracked ? "?" : ""}${file.conflicted ? "!" : ""}${file.origPath ?? ""}`
}

/** Which diff a changed file shows: the staged one when that is all there is. */
export function scopeFor(file: { untracked: boolean; index: string; worktree: string }): "worktree" | "index" | "untracked" {
  if (file.untracked) return "untracked"
  if (file.worktree !== "." ) return "worktree"
  return "index"
}
