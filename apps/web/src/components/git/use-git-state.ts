"use client"

import * as React from "react"
import type { GitBranchList, GitCommitDetail, GitDiff, GitLogPage, GitStatus } from "@ucch/protocol"

import { isOwnChange, useProjectEvents } from "@/lib/realtime"
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

/** How often the view asks again when nothing has told it to. */
const POLL_MS = 10_000
/** Events arrive in bursts (one per file the agent wrote); refetch once per burst. */
const DEBOUNCE_MS = 300

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

export function useGitState(project: Project): GitState {
  const { id: projectId } = project
  // A project session's worktree when the page is one's: each session is
  // its own branch, with its own status and history.
  const projectHash = project.hash
  const sessionHash = project.sessionHash ?? null
  const hash = React.useMemo(() => targetOf({ hash: projectHash, sessionHash }), [projectHash, sessionHash])
  const [status, setStatus] = React.useState<GitStatus | null>(null)
  const [branches, setBranches] = React.useState<GitBranchList | null>(null)
  const [log, setLog] = React.useState<GitLogPage | null>(null)
  const [commits, setCommits] = React.useState<GitLogPage["commits"]>([])
  const [selection, setSelection] = React.useState<GitSelection | null>(null)
  const [diff, setDiff] = React.useState<GitDiff | null>(null)
  const [commit, setCommit] = React.useState<GitCommitDetail | null>(null)
  const [diffLoading, setDiffLoading] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [notRepo, setNotRepo] = React.useState(false)
  const [loading, setLoading] = React.useState(true)

  const selectionRef = React.useRef(selection)
  selectionRef.current = selection

  const refresh = React.useCallback(async () => {
    try {
      const [nextStatus, nextBranches, nextLog] = await Promise.all([
        fetchGitStatus(hash),
        fetchGitBranches(hash),
        fetchGitLog(hash, 0, 50),
      ])
      setStatus(nextStatus)
      setBranches(nextBranches)
      setLog(nextLog)
      setCommits(nextLog.commits)
      setNotRepo(false)
    } catch (caught) {
      if (caught instanceof GitApiError && caught.notRepo) setNotRepo(true)
      else setError(caught instanceof Error ? caught.message : "Could not read the repository.")
    } finally {
      setLoading(false)
    }
  }, [hash])

  // First read, and a slow poll for anything the events do not carry
  // (a fetch from the terminal, a commit made by hand).
  React.useEffect(() => {
    void refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh()
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // Live refresh: the agent's writes and this view's own mutations reach
  // every open tab as events on the project topic. A burst is folded into
  // one refetch.
  const pending = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current)
    },
    [],
  )
  useProjectEvents(projectId, (event) => {
    const changed =
      event.type === "file.changed" ||
      event.type === "git.committed" ||
      event.type === "git.pushed" ||
      // Staging, a checkout, a branch: the index and refs, from another tab.
      (event.type === "resource.changed" && event.resource === "git" && !isOwnChange(event.origin))
    if (!changed) return
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      void refresh()
    }, DEBOUNCE_MS)
  })

  // The diff follows the selection. Keyed on its parts rather than the
  // object so a refresh that rebuilds the same selection does not refetch.
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
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not read the diff.")
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [hash, selKind, selPath, selScope, selSha])

  // When the status changes under a selected change, the selection may no
  // longer exist (the file was committed) or its scope may have moved (it
  // was staged). Follow it, or drop it.
  React.useEffect(() => {
    const current = selectionRef.current
    if (!status || !current || current.kind !== "change") return
    const file = status.files.find((f) => f.path === current.path)
    if (!file) {
      setSelection(null)
      return
    }
    const scope = scopeFor(file)
    if (scope !== current.scope) setSelection({ kind: "change", path: current.path, scope })
    else {
      // Same scope, but the content may have changed; the diff effect keys
      // on the selection, so ask again directly.
      fetchGitDiff(hash, current.path, scope).then(setDiff, () => {})
    }
  }, [status, hash])

  const mutate = React.useCallback(
    async <T extends GitStatus | { status: GitStatus }>(label: string, work: () => Promise<T>): Promise<T | null> => {
      setBusy(label)
      setError(null)
      try {
        const result = await work()
        setStatus("status" in result ? result.status : result)
        // Branches and history can both have moved; the status alone does not say.
        void Promise.all([fetchGitBranches(hash), fetchGitLog(hash, 0, 50)]).then(([b, l]) => {
          setBranches(b)
          setLog(l)
          setCommits(l.commits)
        })
        return result
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : `Could not ${label.toLowerCase()}.`)
        return null
      } finally {
        setBusy(null)
      }
    },
    [hash],
  )

  const loadMoreHistory = React.useCallback(async () => {
    if (!log?.hasMore) return
    try {
      const page = await fetchGitLog(hash, commits.length, 50)
      setLog(page)
      setCommits((prev) => [...prev, ...page.commits])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read more history.")
    }
  }, [hash, log?.hasMore, commits.length])

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
    clearError: () => setError(null),
  }
}

/** Which diff a changed file shows: the staged one when that is all there is. */
export function scopeFor(file: { untracked: boolean; index: string; worktree: string }): "worktree" | "index" | "untracked" {
  if (file.untracked) return "untracked"
  if (file.worktree !== "." ) return "worktree"
  return "index"
}
