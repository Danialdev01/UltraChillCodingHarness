"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { qk } from "@/lib/query-keys"
import type { Bootstrap } from "@/lib/session"

/**
 * What the shell knows about the signed-in person: the server renders it
 * (`getBootstrap`) and seeds it here, and from then on it is a query like any
 * other -- revalidated when the tab comes back, refreshed by realtime events
 * that change a workspace, persisted so a reload opens on it.
 */
export async function fetchBootstrap(ws?: string | null): Promise<Bootstrap> {
  const response = await fetch(`/api/bootstrap${ws ? `?ws=${encodeURIComponent(ws)}` : ""}`, {
    credentials: "include",
  })
  if (!response.ok) throw new Error(`bootstrap failed: ${response.status}`)
  return (await response.json()) as Bootstrap
}

/** Puts the server's bootstrap into the cache before anything below reads it. */
export function BootstrapSeed({ data }: { data: Bootstrap }) {
  const client = useQueryClient()
  const ws = data.workspaces.find((w) => w.id === data.activeWorkspaceId)?.hash ?? null
  // During render rather than in an effect, so the first render below already
  // finds it -- and only when newer than what is there, so a stale server
  // render never overwrites what a realtime event already updated.
  const seeded = React.useRef(false)
  if (!seeded.current) {
    seeded.current = true
    const state = client.getQueryState(qk.bootstrap(ws))
    if (!state || state.dataUpdatedAt < Date.now() - 1000) client.setQueryData(qk.bootstrap(ws), data)
  }
  return null
}

export function useBootstrap(ws?: string | null) {
  return useQuery({
    queryKey: qk.bootstrap(ws),
    queryFn: () => fetchBootstrap(ws),
    meta: { persist: true },
  })
}

/**
 * The shell's lists -- workspaces, the open workspace's projects and
 * connections -- live: the server's copy until the cache has one, then the
 * cache's, which realtime events keep current (`realtime-cache.ts`). This is
 * what lets another member's new project appear in the sidebar without the
 * layout being rendered again.
 */
export function useShellLists<W extends { id: string; hash: string }, P, C>(initial: {
  workspaces: W[]
  activeWorkspaceId: string
  projects: P[]
  connections: C[]
}): { workspaces: W[]; projects: P[]; connections: C[] } {
  const hash = initial.workspaces.find((w) => w.id === initial.activeWorkspaceId)?.hash ?? null
  const { data } = useBootstrap(hash)
  if (!data || data.activeWorkspaceId !== initial.activeWorkspaceId) return initial
  return {
    workspaces: data.workspaces as unknown as W[],
    projects: data.projects as unknown as P[],
    connections: data.connections as unknown as C[],
  }
}
