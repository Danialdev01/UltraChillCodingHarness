"use client"

import * as React from "react"
import type { DomainEvent } from "@ucch/protocol"

import type { UcchClient } from "@/lib/client"
import { readCredentialChoice } from "@/lib/credential-choice"
import { useCachedState } from "@/lib/queries/cached-state"
import { projectQueries } from "@/lib/queries/project-data"
import { useRealtime } from "@/lib/realtime"
import type { ProjectSession } from "@/lib/session"

export type { ProjectSession }

export { fetchProjectSessions } from "@/lib/queries/project-data"

/**
 * Starts a session in a project and answers with its address.
 *
 * With `baseBranch` it is a parallel session: the server forks a branch of
 * its own, `ucch/{hash}`, from `baseBranch` and checks it out in a worktree
 * of its own, so any number of sessions -- on the same base or different
 * ones -- run side by side without sharing a checkout. Without one it works
 * in the project's main checkout, as the first session of a project does.
 */
export async function startProjectSession(
  client: UcchClient,
  project: { id: string; workspaceId?: string },
  options: { baseBranch?: string | null; title?: string } = {},
): Promise<{ threadId: string; hash: string }> {
  const credentialSource = readCredentialChoice(project.workspaceId)
  const created = await client.dispatch({
    type: "thread.create",
    projectId: project.id,
    ...(options.title ? { title: options.title } : {}),
    ...(options.baseBranch ? { baseBranch: options.baseBranch } : {}),
    ...(credentialSource ? { credentialSource } : {}),
  })
  const event = created[0]?.event
  if (event?.type !== "thread.created" || !event.hash) throw new Error("The session could not be started.")
  return { threadId: event.threadId, hash: event.hash }
}

/**
 * Settles or removes a project session.
 *
 * Settling (the default) commits whatever the session left uncommitted and
 * merges its branch into the project's base branch; the session stays,
 * marked settled. A conflict throws `SettleConflictError` with the files,
 * and the session is left as it was. With `ifEmpty` it
 * is removed only if nothing was said or changed in it -- what leaving a
 * session asks -- and `keepalive` lets that request outlive the page. With
 * `discard` nothing is committed or pushed: the changes are dropped with the
 * worktree and the branch.
 */
export async function settleProjectSession(
  projectHash: string,
  sessionHash: string,
  options: { ifEmpty?: boolean; discard?: boolean } = {},
): Promise<SettleResult> {
  const query = options.ifEmpty ? "?ifEmpty=1" : options.discard ? "?discard=1" : ""
  const response = await fetch(
    `/api/projects/${projectHash}/sessions/${sessionHash}${query}`,
    { method: "DELETE", credentials: "include", keepalive: options.ifEmpty === true },
  )
  const body = (await response.json().catch(() => ({}))) as Partial<SettleResult> & {
    error?: string
    conflicts?: string[]
  }
  if (!response.ok) {
    if (Array.isArray(body.conflicts)) {
      throw new SettleConflictError(body.error ?? "The merge conflicts.", body.baseBranch ?? null, body.conflicts)
    }
    throw new Error(body.error ?? "Could not settle the session.")
  }
  return {
    removed: body.removed === true,
    settled: body.settled === true,
    pushed: body.pushed ?? null,
    pushError: body.pushError ?? null,
    baseBranch: body.baseBranch ?? null,
    mergeCommitSha: body.mergeCommitSha ?? null,
  }
}

/** What settling did: merged into `baseBranch` at `mergeCommitSha`, or -- with nothing to merge -- removed. */
export interface SettleResult {
  removed: boolean
  settled: boolean
  /** The base branch, when it was pushed to origin afterwards. */
  pushed: string | null
  pushError: string | null
  baseBranch: string | null
  mergeCommitSha: string | null
}

/** Settling stopped on a conflict: the merge was aborted and the session left as it was. */
export class SettleConflictError extends Error {
  constructor(
    message: string,
    readonly baseBranch: string | null,
    readonly conflicts: string[],
  ) {
    super(message)
    this.name = "SettleConflictError"
  }
}

/** What settling a session would involve: work to merge, and where it would go. */
export interface SettleCheck {
  changes: boolean
  hasRemote: boolean
  running: boolean
  /** The session's own branch, `ucch/{hash}`; null for one with no worktree. */
  branch: string | null
  /** The project's base branch, which settling merges into. */
  baseBranch: string | null
}

export async function fetchSettleCheck(projectHash: string, sessionHash: string): Promise<SettleCheck> {
  const response = await fetch(`/api/projects/${projectHash}/sessions/${sessionHash}/settle`, { credentials: "include" })
  const body = (await response.json().catch(() => ({}))) as Partial<SettleCheck> & { error?: string }
  if (!response.ok) throw new Error(body.error ?? "Could not check the session.")
  return {
    changes: body.changes === true,
    hasRemote: body.hasRemote === true,
    running: body.running === true,
    branch: body.branch ?? null,
    baseBranch: body.baseBranch ?? null,
  }
}

/**
 * Leaving an empty session removes it -- a moment later, so that the same
 * session mounting again straight away (a re-render keyed the same, React's
 * development double mount) cancels it. The server checks again that it is
 * empty, so a race can only ever keep a session, never lose one.
 */
const leaving = new Map<string, number>()

export function removeWhenLeft(projectHash: string, sessionHash: string): void {
  window.clearTimeout(leaving.get(sessionHash))
  leaving.set(
    sessionHash,
    window.setTimeout(() => {
      leaving.delete(sessionHash)
      void settleProjectSession(projectHash, sessionHash, { ifEmpty: true }).catch(() => {})
    }, 1500),
  )
}

/** The session is on screen again: it is not being left after all. */
export function keepSession(sessionHash: string): void {
  window.clearTimeout(leaving.get(sessionHash))
  leaving.delete(sessionHash)
}

/** What changes a project's session list: one starting or going, its worktree, its turns. */
const SESSION_EVENTS: ReadonlySet<DomainEvent["type"]> = new Set([
  "thread.created",
  "thread.removed",
  "thread.settled",
  "thread.worktree_ready",
  "thread.worktree_failed",
  "turn.started",
  "agent.turn_completed",
  "agent.turn_failed",
])

/**
 * A project's sessions, kept current from the socket.
 *
 * `null` until the first answer, so a caller can draw a skeleton rather than
 * flash "no sessions". Pass a null hash to fetch nothing -- a folded sidebar
 * row does not need its sessions.
 */
export function useProjectSessions(
  project: { id: string; hash: string } | null,
): { sessions: ProjectSession[] | null; refresh: () => void } {
  const { client } = useRealtime()
  const projectHash = project?.hash ?? null
  const projectId = project?.id ?? null
  // Cached and shared: the sidebar's row and the project's own page read one
  // copy, and a project opened before shows its sessions at once.
  const query = projectQueries.sessions(projectHash ?? "")
  const [listed, , reload, state] = useCachedState(query.queryKey, query.queryFn, {
    persist: query.persist,
    enabled: projectHash !== null,
  })
  const refresh = React.useCallback(() => {
    if (projectHash) void reload()
  }, [projectHash, reload])

  React.useEffect(() => {
    if (!client || !projectId) return
    void client.subscribe({ name: "project", projectId, quiet: true }).catch(() => {})
    // Several of these arrive together when a turn ends; one refetch covers them.
    let timer: number | undefined
    const off = client.onEvent(({ event, projectId: from }) => {
      if (from !== projectId || !SESSION_EVENTS.has(event.type)) return
      window.clearTimeout(timer)
      timer = window.setTimeout(refresh, 150)
    })
    return () => {
      window.clearTimeout(timer)
      off()
    }
  }, [client, projectId, refresh])

  // A failed first load reads as empty rather than as a skeleton forever.
  const sessions = listed ?? (state.error ? [] : null)
  return { sessions: projectHash ? sessions : null, refresh }
}
