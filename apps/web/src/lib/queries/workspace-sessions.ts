"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { qk } from "../query-keys"
import { useRealtime } from "../realtime"
import type { LiveTurnState, SidebarMode, WorkspaceSessions } from "../session-sidebar"

/** Every session in a workspace, with its projects, as the sidebar lists them. */
export async function fetchWorkspaceSessions(workspaceId: string, archived = false): Promise<WorkspaceSessions> {
  const response = await fetch(`/api/workspaces/${workspaceId}/sessions${archived ? "?archived=1" : ""}`, {
    credentials: "include",
  })
  if (!response.ok) throw new Error("Could not list the workspace's sessions.")
  return (await response.json()) as WorkspaceSessions
}

/**
 * The sidebar's list. Kept fresh by the cache bridge: a session made,
 * renamed, pinned, archived or removed, and every turn's end, invalidate
 * `sessions.all` (`realtime-cache.ts`). Polls slowly as well, as a backstop
 * for a socket that dropped without the tab noticing.
 */
export function useWorkspaceSessions(workspaceId: string, archived: boolean) {
  return useQuery({
    queryKey: qk.sessions.workspace(workspaceId, archived),
    queryFn: () => fetchWorkspaceSessions(workspaceId, archived),
    enabled: Boolean(workspaceId),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  })
}

/** Which session each live `project.activity` last said something about, and what. */
export interface LiveTurns {
  states: ReadonlyMap<string, { state: LiveTurnState; at: number }>
}

/**
 * What the socket has said about each session's turn, read off the
 * workspace topic the shell already holds (`project.activity`). Entries
 * heard before the list was last read are dropped by the caller: the row is
 * newer than they are.
 */
export function useLiveTurns(): ReadonlyMap<string, { state: LiveTurnState; at: number }> {
  const { client } = useRealtime()
  const [states, setStates] = React.useState<ReadonlyMap<string, { state: LiveTurnState; at: number }>>(
    () => new Map(),
  )
  React.useEffect(() => {
    if (!client) return
    return client.onEvent(({ event, receivedAt }) => {
      if (event.type !== "project.activity") return
      setStates((current) => {
        const next = new Map(current)
        next.set(event.threadId, { state: event.state, at: receivedAt })
        return next
      })
    })
  }, [client])
  return states
}

// -- Preferences --------------------------------------------------------------

const MODE_KEY = "ucch:sidebar-mode"

function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    /* not remembered in this browser; the server copy still is */
  }
}

const isMode = (value: unknown): value is SidebarMode => value === "sessions" || value === "projects"

/**
 * Sessions or Projects, per person. This browser's copy paints first; the
 * account's (`users.sidebar_mode`) is read once and wins when this browser
 * has none, so a second device opens the same way. A change goes to both.
 */
export function useSidebarMode(fallback: SidebarMode): [SidebarMode, (mode: SidebarMode) => void] {
  const [mode, setMode] = React.useState<SidebarMode>(fallback)
  React.useEffect(() => {
    const local = readStored(MODE_KEY)
    if (isMode(local)) {
      setMode(local)
      return
    }
    let cancelled = false
    void fetch("/api/account/sidebar-mode", { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<{ mode: unknown }>) : null))
      .then((body) => {
        if (!cancelled && body && isMode(body.mode)) setMode(body.mode)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  const change = React.useCallback((next: SidebarMode) => {
    setMode(next)
    store(MODE_KEY, next)
    void fetch("/api/account/sidebar-mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ mode: next }),
    }).catch(() => {})
  }, [])
  return [mode, change]
}

/** The project groups folded away in a workspace, remembered in this browser. */
export function useCollapsedProjects(workspaceId: string): [ReadonlySet<string>, (projectId: string) => void] {
  const key = `ucch:sidebar-collapsed:${workspaceId}`
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(() => new Set())
  React.useEffect(() => {
    try {
      const parsed = JSON.parse(readStored(key) ?? "[]") as unknown
      setCollapsed(new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []))
    } catch {
      setCollapsed(new Set())
    }
  }, [key])
  const toggle = React.useCallback(
    (projectId: string) => {
      setCollapsed((current) => {
        const next = new Set(current)
        if (next.has(projectId)) next.delete(projectId)
        else next.add(projectId)
        store(key, JSON.stringify([...next]))
        return next
      })
    },
    [key],
  )
  return [collapsed, toggle]
}

/** Debounced copy of a value: the search box filters after typing pauses. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return debounced
}
