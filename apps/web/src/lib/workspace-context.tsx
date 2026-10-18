"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"

import { projectHref, workspaceHashFromPath } from "@/lib/sections"
import { WORKSPACE_COOKIE_NAME, WORKSPACE_HASH_COOKIE_NAME } from "@/lib/workspace-cookie"
import type { Workspace, WorkspaceKind } from "@/lib/session"

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
  return React.useCallback(
    (projectHash: string, sessionHash?: string | null) => projectHref(ws, kind, projectHash, sessionHash),
    [ws, kind],
  )
}
