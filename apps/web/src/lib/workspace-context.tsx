"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"

import { projectHref, workspaceHashFromPath } from "@/lib/sections"
import { WORKSPACE_COOKIE_NAME, WORKSPACE_HASH_COOKIE_NAME } from "@/lib/workspace-cookie"
import { useBootstrap } from "@/lib/queries/bootstrap"
import { useShellPathname } from "@/lib/view-transitions"
import type { DatabaseConnectionSummary } from "@ucch/protocol"
import type { Bootstrap, Project, ProjectSession, Workspace, WorkspaceKind } from "@/lib/session"
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

/** What the shell draws: the open workspace, and the lists around it. */
export interface Shell {
  me: Bootstrap["me"]
  workspace: Workspace | undefined
  workspaces: Workspace[]
  projects: Project[]
  connections: DatabaseConnectionSummary[]
  /** The workspace is known but its projects and connections have not arrived. */
  loading: boolean
}

const ShellContext = React.createContext<Shell | null>(null)

const activeOf = (boot: Bootstrap) => boot.workspaces.find((w) => w.id === boot.activeWorkspaceId)

/** A bootstrap as the shell draws it. */
function shellOf(boot: Bootstrap): Shell {
  return {
    me: boot.me,
    workspace: activeOf(boot),
    workspaces: boot.workspaces,
    projects: boot.projects,
    connections: boot.connections,
    loading: false,
  }
}

/**
 * The shell for workspace `wanted`. Its own bootstrap when that is cached;
 * until then what is already known of it -- its row in the workspace list --
 * with empty lists marked `loading`. `addressed` is whether the URL names
 * it: an address the caller has no workspace for keeps the shell as it is
 * (the page redirects or 404s), while a remembered workspace that is gone
 * falls back to whichever the server picked.
 */
export function resolveShell({
  wanted,
  addressed,
  cached,
  server,
  last,
}: {
  wanted: string | null
  addressed: boolean
  cached: Bootstrap | undefined
  server: Bootstrap
  last: Shell
}): Shell {
  if (cached && (!addressed || activeOf(cached)?.hash === wanted)) return shellOf(cached)
  if ((activeOf(server)?.hash ?? null) === wanted) return shellOf(server)
  const row = cached ? undefined : last.workspaces.find((w) => w.hash === wanted)
  if (row) return { ...last, workspace: row, projects: [], connections: [], loading: true }
  return last
}

/**
 * The workspace on screen, for the client components under it.
 *
 * The shell is a layout, kept across navigations, so the server does not
 * render it again for another workspace's address. The address decides here
 * instead, from the client cache: the name and logo change in the frame of
 * the click, and the lists with them when the switcher has loaded them.
 */
export function ActiveWorkspaceProvider({ boot, children }: { boot: Bootstrap; children: React.ReactNode }) {
  const router = useRouter()
  const addressed = workspaceHashFromPath(useShellPathname())
  const last = React.useRef<Shell | null>(null)
  last.current ??= shellOf(boot)
  // Pages outside any workspace (`/`, `/setting`) keep the last one open.
  const wanted = addressed ?? last.current.workspace?.hash ?? null
  const { data, isError } = useBootstrap(wanted)

  const shell = React.useMemo(
    () =>
      resolveShell({
        wanted,
        addressed: addressed !== null,
        cached: data,
        server: boot,
        last: last.current!,
      }),
    [wanted, addressed, data, boot],
  )
  React.useEffect(() => {
    last.current = shell
  }, [shell])

  // Its lists could not be read from here: ask the server for the layout.
  const failed = isError && shell.loading
  React.useEffect(() => {
    if (failed) router.refresh()
  }, [failed, router])

  const id = shell.workspace?.id
  const hash = shell.workspace?.hash
  const kind = shell.workspace?.kind
  React.useEffect(() => {
    if (id && hash) rememberWorkspace({ id, hash })
  }, [id, hash])

  const value = React.useMemo(() => (id && hash && kind ? { id, hash, kind } : null), [id, hash, kind])
  return (
    <ShellContext.Provider value={shell}>
      <ActiveWorkspaceContext.Provider value={value}>{children}</ActiveWorkspaceContext.Provider>
    </ShellContext.Provider>
  )
}

/** The shell's workspace and lists, kept live by realtime events (`realtime-cache.ts`). */
export function useShell(): Shell {
  const shell = React.useContext(ShellContext)
  if (!shell) throw new Error("useShell must be used inside <ActiveWorkspaceProvider>")
  return shell
}

/** The signed-in person, live. Undefined outside the shell. */
export function useMe(): Bootstrap["me"] | undefined {
  return React.useContext(ShellContext)?.me
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
  const fromPath = workspaceHashFromPath(useShellPathname())
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
