"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import type { DomainEvent, LiveResource, PresenceViewer } from "@ucch/protocol"

import { UcchClient, type ClientEvent } from "@/lib/client"
import { TAB_ID, installTabHeader } from "@/lib/tab-id"

/**
 * One socket per tab for everything that only needs to hear that something
 * changed: notes, activity, presence, settings. Views with their own
 * long-lived streams -- the chat, a terminal -- keep their own.
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

  const toast = React.useCallback((input: ToastInput) => {
    const id = next.current++
    setToasts((current) => [...current.slice(-3), { ...input, id }])
    window.setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 6000)
  }, [])

  const value = React.useMemo(() => ({ client, toast }), [client, toast])

  return (
    <RealtimeContext.Provider value={value}>
      {children}
      <AccountRefresher client={client} />
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
 * The handler is read through a ref, so passing a new function each render
 * does not resubscribe.
 */
export function useProjectEvents(
  projectId: string | null | undefined,
  handler: (event: DomainEvent, row: ClientEvent) => void,
): UcchClient | null {
  const { client } = useRealtime()
  const ref = React.useRef(handler)
  ref.current = handler

  React.useEffect(() => {
    if (!client || !projectId) return
    void client.subscribe({ name: "project", projectId, quiet: true }).catch(() => {})
    return client.onEvent((row) => {
      const event = row.event
      if (!("projectId" in event) || event.projectId !== projectId) return
      ref.current(event, row)
    })
  }, [client, projectId])

  return client
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
 * The shell's own lists -- projects, connections, the account -- are
 * rendered on the server, so a change made in another window refreshes the
 * route rather than patching state that lives nowhere on this side.
 */
function AccountRefresher({ client }: { client: UcchClient | null }) {
  const router = useRouter()
  React.useEffect(() => {
    if (!client) return
    let timer: number | undefined
    const off = client.onEvent(({ event }) => {
      if (event.type !== "resource.changed" || isOwnChange(event.origin)) return
      if (!["projects", "database_connections", "account_settings", "project_settings"].includes(event.resource)) {
        return
      }
      // Several changes in a burst -- a form saving three fields -- are one refresh.
      window.clearTimeout(timer)
      timer = window.setTimeout(() => router.refresh(), 300)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [client, router])
  return null
}
