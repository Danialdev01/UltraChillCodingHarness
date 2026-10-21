"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"

import { projectHref, workspaceHashFromPath } from "@/lib/sections"
import { WORKSPACE_COOKIE_NAME, WORKSPACE_HASH_COOKIE_NAME } from "@/lib/workspace-cookie"
import type { ProjectSession, Workspace, WorkspaceKind } from "@/lib/session"
import { qk } from "@/lib/query-keys"
import { isTaskThreadTitle } from "@/lib/tasks-api"

interface ActiveWorkspace {
  id: string
  hash: string
  kind: WorkspaceKind
}

const ActiveWorkspaceContext = React.createContext<ActiveWorkspace | null>(null)

/**
 * Remembers the last workspace open, for the pages outside any (`/`,
 * `/setting`): the server reads it from here when the URL does not say.
 */
export function rememberWorkspace(workspace: { id: string; hash: string }): void {
  const options = `path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  document.cookie = `${WORKSPACE_COOKIE_NAME}=${workspace.id}; ${options}`
  document.cookie = `${WORKSPACE_HASH_COOKIE_NAME}=${workspace.hash}; ${options}`
}

/**
 * The workspace the shell rendered, for the client components under it.
 *
 * The shell is a layout, and a layout is kept across navigations -- so going
 * from one workspace's address to another's does not render it again, and
 * the sidebar would go on listing the old workspace's projects. When the URL
 * names a workspace the shell did not render, this asks the server for the
 * layout again, once per workspace.
 */
export function ActiveWorkspaceProvider({
  workspace,
  workspaces,
  children,
}: {
  workspace: Workspace | undefined
  workspaces: readonly Workspace[]
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const addressed = workspaceHashFromPath(pathname)
  const stale = addressed !== null && addressed !== workspace?.hash && workspaces.some((w) => w.hash === addressed)

  const refreshedFor = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!stale || refreshedFor.current === addressed) return
    refreshedFor.current = addressed
    router.refresh()
  }, [stale, addressed, router])

  const id = workspace?.id
  const hash = workspace?.hash
  React.useEffect(() => {
    if (id && hash) rememberWorkspace({ id, hash })
  }, [id, hash])

  const value = React.useMemo(
    () => (workspace ? { id: workspace.id, hash: workspace.hash, kind: workspace.kind } : null),
    [workspace],
  )
  return <ActiveWorkspaceContext.Provider value={value}>{children}</ActiveWorkspaceContext.Provider>
}

/** The workspace the shell has open, or null when there is none. */
export function useActiveWorkspace(): ActiveWorkspace | null {
  return React.useContext(ActiveWorkspaceContext)
}

/**
 * The hash to build workspace links with: the URL's when it names one --
 * known the moment the address changes -- else the shell's.
 */
export function useWorkspaceHash(): string {
  const fromPath = workspaceHashFromPath(usePathname())
  const active = useActiveWorkspace()
  return fromPath ?? active?.hash ?? ""
}

/**
 * Builds the address of a project of the open workspace -- `/{ws}/s/{hash}`
 * in a session workspace, `/{ws}/p/{hash}[/{session}]` in a project one.
 */
export function useProjectHref(): (projectHash: string, sessionHash?: string | null) => string {
  const ws = useWorkspaceHash()
  const kind = useActiveWorkspace()?.kind ?? "project"
  const queryClient = useQueryClient()
  const sessionsLanded = useSessionListsVersion(queryClient)
  return React.useCallback(
    (projectHash: string, sessionHash?: string | null) => {
      // A project's bare address only redirects to its newest session. When
      // the sessions are cached, link there directly: one round trip, not two.
      if (!sessionHash && kind === "project") {
        const sessions = queryClient.getQueryData<ProjectSession[]>(qk.sessions.list(projectHash))
        sessionHash = sessions?.find((s) => !isTaskThreadTitle(s.title))?.hash ?? null
      }
      return projectHref(ws, kind, projectHash, sessionHash)
    },
    // `sessionsLanded` is not read: it is what makes links drawn before a
    // project's sessions arrived -- before the boot preload filled them in --
    // be drawn again, now pointing at the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ws, kind, queryClient, sessionsLanded],
  )
}

/** Counts sessions lists arriving in the cache, at most once a frame. */
function useSessionListsVersion(queryClient: QueryClient): number {
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => {
    let frame = 0
    const off = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return
      if (event.query.queryKey[0] !== qk.sessions.all[0] || frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setVersion((v) => v + 1)
      })
    })
    return () => {
      cancelAnimationFrame(frame)
      off()
    }
  }, [queryClient])
  return version
}
