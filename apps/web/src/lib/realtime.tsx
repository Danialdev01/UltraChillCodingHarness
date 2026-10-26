"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { DomainEvent, LiveResource, PresenceViewer } from "@ucch/protocol"

import {
  agentStatus,
  nextExpiry,
  reduceActivity,
  type ActivityState,
  type AgentStatus,
} from "@/lib/agent-activity"
import { UcchClient, type ClientEvent } from "@/lib/client"
import { cacheEffect, cacheSink } from "@/lib/realtime-cache"
import { TAB_ID, installTabHeader } from "@/lib/tab-id"
import { useActiveWorkspace } from "@/lib/workspace-context"

/**
 * One socket per tab, for every view: notes, activity, presence, settings,
 * terminals, and the chat, which holds its thread's subscription on it
 * (`UcchClient.hold`). Only `create-project.ts` opens one of its own, for
 * one command.
 */
interface Realtime {
  client: UcchClient | null
  toast(toast: ToastInput): void
}

// As early as the module loads, so the first requests a page makes carry it too.
installTabHeader()

const RealtimeContext = React.createContext<Realtime>({ client: null, toast: () => {} })

export interface ToastInput {
  title: string
  description?: string
  tone?: "error" | "info"
}

interface Toast extends ToastInput {
  id: number
}

/** Whether a change came from this very tab -- its own echo, already on screen. */
export function isOwnChange(origin: { clientId: string } | null | undefined): boolean {
  return origin?.clientId === TAB_ID
}

export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = React.useState<UcchClient | null>(null)
  const [toasts, setToasts] = React.useState<Toast[]>([])
  const next = React.useRef(0)

  React.useEffect(() => {
    installTabHeader()
    const instance = new UcchClient()
    setClient(instance)
    void instance.connect()
    void instance.subscribe({ name: "user" })
    return () => {
      instance.close()
      setClient(null)
    }
  }, [])

  // The open workspace's topic: projects, members, connections and settings
  // that every member's sidebar shows. A workspace left behind keeps its
  // subscription until the tab closes -- it is still the person's, and its
  // events only refresh caches.
  const workspaceId = useActiveWorkspace()?.id ?? null
  React.useEffect(() => {
    if (!client || !workspaceId) return
    void client.subscribe({ name: "workspace", workspaceId }).catch(() => {})
  }, [client, workspaceId])

  const toast = React.useCallback((input: ToastInput) => {
    const id = next.current++
    setToasts((current) => [...current.slice(-3), { ...input, id }])
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000)
  }, [])

  const value = React.useMemo(() => ({ client, toast }), [client, toast])

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      <CacheBridge client={client} />
      <ConnectionBanner client={client} />
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={
              "pointer-events-auto rounded-md border px-3 py-2 text-sm shadow-lg " +
              (t.tone === "error"
                ? "border-destructive/40 bg-background text-destructive"
                : "bg-background text-foreground")
            }
          >
            <p className="font-medium">{t.title}</p>
            {t.description && <p className="text-muted-foreground mt-0.5 text-xs">{t.description}</p>}
          </div>
        ))}
      </div>
    </RealtimeContext.Provider>
  )
}

export function useRealtime(): Realtime {
  return React.useContext(RealtimeContext)
}

export function useToast(): Realtime["toast"] {
  return React.useContext(RealtimeContext).toast
}

/**
 * Calls `handler` for every event on the project's topic. Quiet: the token
 * and terminal streams are left out on the server.
 *
 * `files: true` is for views that show files: while it is set, the server
 * watches the project's directory, so changes made outside it -- a
 * terminal, a dev server, git -- arrive as `file.changed` too. Without it,
 * only the changes the server and the agent make themselves do. `tree`, a
 * session's hash, watches that session's worktree instead of the checkout.
 *
 * The handler is read through a ref, so passing a new function each render
 * does not resubscribe.
 */
export function useProjectEvents(
  projectId: string | null | undefined,
  handler: (event: DomainEvent, row: ClientEvent) => void,
  options: { files?: boolean; tree?: string | null } = {},
): UcchClient | null {
  const { client } = useRealtime()
  const ref = React.useRef(handler)
  ref.current = handler
  const files = options.files === true
  const tree = options.tree ?? null

  React.useEffect(() => {
    if (!client || !projectId) return
    // Files first, so a first subscription asks for them at once rather
    // than being upgraded straight after.
    const release = files ? client.holdFiles(projectId, tree) : undefined
    void client.subscribe({ name: "project", projectId, quiet: true }).catch(() => {})
    const off = client.onEvent((row) => {
      const event = row.event
      if (!("projectId" in event) || event.projectId !== projectId) return
      ref.current(event, row)
    })
    return () => {
      off()
      release?.()
    }
  }, [client, projectId, files, tree])

  return client
}

/**
 * Whether each project's agent is working, done, or idle, for the sidebar.
 *
 * Read off the workspace topic, which the shell holds already: the server
 * sends it `project.activity` for every turn picked up, started or ended in
 * any of its projects, so a sidebar of twenty projects subscribes to none of
 * them. `running` and `failed` on each project are the page's own snapshot,
 * used until the socket has something newer to say.
 */
export function useAgentActivity(): (project: { id: string; running?: boolean; failed?: boolean }) => AgentStatus {
  const { client } = useRealtime()
  const [state, setState] = React.useState<ActivityState>({})
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!client) return
    return client.onEvent(({ event, receivedAt }) => {
      if (event.type !== "project.activity") return
      setState((current) => reduceActivity(current, event, receivedAt))
      setNow(Date.now())
    })
  }, [client])

  // One timer for whichever done mark lapses first, so the row turns back
  // without the sidebar re-rendering on a clock.
  React.useEffect(() => {
    const next = nextExpiry(state, now)
    if (next === null) return
    const timer = window.setTimeout(() => setNow(Date.now()), next - now)
    return () => window.clearTimeout(timer)
  }, [state, now])

  return (project) =>
    agentStatus(state[project.id], project.running === true, now, project.failed === true)
}

/** Everyone with the project open, and where. Includes this tab. */
export function usePresence(projectId: string | null | undefined): PresenceViewer[] {
  const [viewers, setViewers] = React.useState<PresenceViewer[]>([])
  useProjectEvents(projectId, (event) => {
    if (event.type === "presence.changed") setViewers(event.viewers)
  })
  return viewers
}

/** Says where in the project this tab is, for as long as it is mounted there. */
export function usePresenceLocation(
  projectId: string | null | undefined,
  location: string | null,
  editing = false,
): void {
  const { client } = useRealtime()
  React.useEffect(() => {
    if (!client || !projectId) return
    client.setPresence(projectId, location, editing)
  }, [client, projectId, location, editing])
  React.useEffect(() => {
    if (!client || !projectId) return
    return () => client.setPresence(projectId, null)
  }, [client, projectId])
}

/** The other tabs at the same place as this one. */
export function othersAt(viewers: readonly PresenceViewer[], location: string): PresenceViewer[] {
  return viewers.filter((v) => v.location === location && v.clientId !== TAB_ID)
}

/**
 * Refetches when another tab changes `resource`. Project resources arrive on
 * the project's topic, the account's on the user's; both are heard here.
 */
export function useLiveResource(
  resource: LiveResource,
  refetch: (event: Extract<DomainEvent, { type: "resource.changed" }>) => void,
  projectId?: string | null,
): void {
  const { client } = useRealtime()
  const ref = React.useRef(refetch)
  ref.current = refetch

  React.useEffect(() => {
    if (!client) return
    if (projectId) void client.subscribe({ name: "project", projectId, quiet: true }).catch(() => {})
    return client.onEvent(({ event }) => {
      if (event.type !== "resource.changed" || event.resource !== resource) return
      if (isOwnChange(event.origin)) return
      if (projectId && event.projectId && event.projectId !== projectId) return
      ref.current(event)
    })
  }, [client, resource, projectId])
}

/**
 * Every event, through `realtime-cache.ts`, into the client cache: whatever
 * it changed is marked stale, so the open views refetch it and the rest do
 * when next shown. Nothing here renders the page again.
 */
function CacheBridge({ client }: { client: UcchClient | null }) {
  const queryClient = useQueryClient()
  React.useEffect(() => {
    if (!client) return
    // Several changes in a burst -- a turn ending, a form saving three
    // fields -- are one refetch of each key. A hidden tab only marks its
    // copies stale; it refetches them when it is shown again.
    const sink = cacheSink((key) => {
      void queryClient.invalidateQueries({ queryKey: key, refetchType: document.hidden ? "none" : "active" })
    })
    // Back from a drop: nothing that happened meanwhile was pushed here, so
    // everything on screen refetches (only what is open; the rest is marked
    // stale for when it is next shown).
    const offReconnect = client.onReconnect(() => void queryClient.invalidateQueries())
    const off = client.onEvent(({ event }) => sink.push(cacheEffect(event)))
    return () => {
      off()
      offReconnect()
      sink.dispose()
    }
  }, [client, queryClient])
  return null
}

/**
 * Says so when the live connection is down for more than a moment -- what
 * is on screen may be out of date until it is back -- and retries the moment
 * the network returns. A banner, not a spinner: nothing is blocked.
 */
function ConnectionBanner({ client }: { client: UcchClient | null }) {
  const [down, setDown] = React.useState(false)
  React.useEffect(() => {
    if (!client) return
    let timer: number | undefined
    const update = () => {
      const lost = client.state === "reconnecting" || client.state === "failed"
      window.clearTimeout(timer)
      if (!lost) setDown(false)
      else timer = window.setTimeout(() => setDown(true), 2000)
    }
    const offState = client.subscribeToChanges(update)
    const online = () => client.retryNow()
    window.addEventListener("online", online)
    return () => {
      offState()
      window.removeEventListener("online", online)
      window.clearTimeout(timer)
    }
  }, [client])
  if (!down) return null
  return (
    <div
      role="status"
      className="bg-background text-muted-foreground fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 rounded-md border px-3 py-1.5 text-xs shadow-lg"
    >
      Offline — reconnecting. Changes from others will appear when the connection is back.
    </div>
  )
}
