"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  HandIcon,
  PlusIcon,
  RotateCwIcon,
  UsersIcon,
  XIcon,
} from "lucide-react"

import { EmptyState } from "@/components/layout/empty-state"
import { BrowserViewSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  closeBrowserTab,
  fetchProjectBrowser,
  openBrowserTab,
  type BrowserSessionInfo,
  type BrowserTabInfo,
} from "@/lib/browser-api"
import { websocketOrigin } from "@/lib/client"
import { useProjectSessions } from "@/lib/project-sessions"
import { qk } from "@/lib/query-keys"
import { useProjectEvents, useToast } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"

type Selection = { session: string; tab: string }

/**
 * The agents' shared browser, live.
 *
 * Every session of the project -- each agent's private one and the named
 * ones agents share -- with its tabs on the left; the chosen tab streams on
 * the right. Watching changes nothing. "Take control" makes the tab yours:
 * clicks, keys and the address bar reach the page, and agents may still
 * read it but not act on it until you hand it back (or leave).
 */
export function BrowserView({ project }: { project: Project }) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const { data, isPending, error } = useQuery({
    queryKey: qk.browser.list(project.hash),
    queryFn: () => fetchProjectBrowser(project.hash),
  })
  // `resource.changed{browser}` arrives on the project topic; the cache rule refetches.
  useProjectEvents(project.id, () => {})

  const { sessions: threads } = useProjectSessions(project)
  const agentName = React.useCallback(
    (id: string) => (id === "human" ? "a person" : (threads?.find((t) => t.id === id)?.title ?? `agent ${id.slice(0, 8)}`)),
    [threads],
  )

  const [selected, setSelected] = React.useState<Selection | null>(null)
  const sessions = data?.sessions ?? []
  const current = selected && findTab(sessions, selected)
  // Nothing chosen, or the chosen tab closed: the newest tab, preferring shared sessions.
  React.useEffect(() => {
    if (current || sessions.length === 0) return
    const session = sessions.find((s) => s.tabs.length > 0)
    const tab = session?.tabs.at(-1)
    setSelected(session && tab ? { session: session.name, tab: tab.id } : null)
  }, [current, sessions])

  const refresh = () => void queryClient.invalidateQueries({ queryKey: qk.browser.all })

  if (isPending) return <BrowserViewSkeleton />
  if (error) return <EmptyState icon={GlobeIcon} title="Could not load the browser" description={error.message} />
  if (!data.available) {
    return <EmptyState icon={GlobeIcon} title="No browser on this server" description={data.reason ?? undefined} />
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No browser sessions yet. Agents open tabs with <code>browser_open</code>; you can open one below.
            </p>
          ) : (
            sessions.map((session) => (
              <SessionGroup
                key={session.name}
                session={session}
                selected={selected}
                agentName={agentName}
                onSelect={(tab) => setSelected({ session: session.name, tab })}
                onClose={(tab) =>
                  void closeBrowserTab(project.hash, session.name, tab)
                    .then(refresh)
                    .catch((e: Error) => toast({ title: "Could not close the tab", description: e.message, tone: "error" }))
                }
              />
            ))
          )}
        </div>
        <NewTabForm
          onOpen={async (session, url) => {
            try {
              const opened = await openBrowserTab(project.hash, session, url)
              refresh()
              setSelected(opened)
            } catch (e) {
              toast({ title: "Could not open a tab", description: (e as Error).message, tone: "error" })
            }
          }}
        />
      </aside>
      {current ? (
        <LiveTab key={`${selected!.session}/${selected!.tab}`} project={project} session={selected!.session} tab={current} agentName={agentName} />
      ) : (
        <EmptyState
          icon={GlobeIcon}
          title="Nothing to watch yet"
          description="When an agent opens a page it appears here live. You can watch it work, or take control to log in or show it something."
          className="flex-1"
        />
      )}
    </div>
  )
}

function findTab(sessions: BrowserSessionInfo[], selection: Selection): BrowserTabInfo | null {
  return sessions.find((s) => s.name === selection.session)?.tabs.find((t) => t.id === selection.tab) ?? null
}

function SessionGroup({
  session,
  selected,
  agentName,
  onSelect,
  onClose,
}: {
  session: BrowserSessionInfo
  selected: Selection | null
  agentName: (id: string) => string
  onSelect: (tab: string) => void
  onClose: (tab: string) => void
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
        {session.shared ? <UsersIcon className="size-3.5" /> : <GlobeIcon className="size-3.5" />}
        <span className="truncate">{session.shared ? session.name : `Private · ${agentName(session.owner ?? "")}`}</span>
      </div>
      {session.tabs.length === 0 && <p className="px-2 text-xs text-muted-foreground">No tabs</p>}
      {session.tabs.map((tab) => {
        const active = selected?.session === session.name && selected.tab === tab.id
        return (
          <div
            key={tab.id}
            className={cn("group flex items-start gap-1 rounded-md px-2 py-1.5", active ? "bg-accent text-accent-foreground" : "hover:bg-muted")}
          >
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(tab.id)}>
              <div className="flex items-center gap-1.5">
                {tab.busy && !tab.controlledBy && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="An agent is acting" />}
                <span className="truncate text-sm">{tab.title || hostOf(tab.url) || "New tab"}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {tab.controlledBy ? "A person is in control" : `Opened by ${agentName(tab.openedBy)}`}
              </div>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title || tab.id}`}
              className="invisible mt-0.5 rounded p-0.5 text-muted-foreground group-hover:visible hover:text-foreground focus-visible:visible"
              onClick={() => onClose(tab.id)}
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function hostOf(url: string): string {
  try {
    return url === "about:blank" ? "" : new URL(url).host
  } catch {
    return url
  }
}

function NewTabForm({ onOpen }: { onOpen: (session: string, url: string | null) => Promise<void> }) {
  const [session, setSession] = React.useState("shared")
  const [url, setUrl] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(session) && !session.startsWith("private-")
  return (
    <form
      className="flex flex-col gap-1.5 border-t p-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!valid || busy) return
        setBusy(true)
        void onOpen(session, url.trim() || null).finally(() => {
          setBusy(false)
          setUrl("")
        })
      }}
    >
      <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL (optional)" aria-label="URL" className="h-7 text-xs" />
      <div className="flex gap-1.5">
        <Input
          value={session}
          onChange={(e) => setSession(e.target.value)}
          aria-label="Shared session"
          aria-invalid={!valid}
          className="h-7 min-w-0 flex-1 text-xs"
        />
        <Button type="submit" size="sm" disabled={!valid || busy}>
          <PlusIcon />
          Open
        </Button>
      </div>
    </form>
  )
}

/** One tab's frames, and a person's input while they have control. */
function LiveTab({
  project,
  session,
  tab,
  agentName,
}: {
  project: Project
  session: string
  tab: BrowserTabInfo
  agentName: (id: string) => string
}) {
  const toast = useToast()
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const socketRef = React.useRef<WebSocket | null>(null)
  const sizeRef = React.useRef({ width: tab.viewport.width, height: tab.viewport.height })
  const [connected, setConnected] = React.useState(false)
  const [controlling, setControlling] = React.useState(false)
  const [address, setAddress] = React.useState(tab.url)
  const editingAddress = React.useRef(false)
  if (!editingAddress.current && address !== tab.url) setAddress(tab.url)

  React.useEffect(() => {
    let socket: WebSocket | null = null
    let closed = false
    void (async () => {
      const response = await fetch("/api/ws-ticket", { method: "POST", credentials: "include" })
      if (!response.ok || closed) return
      const { ticket } = (await response.json()) as { ticket: string }
      const query = new URLSearchParams({ ticket, project: project.id, session, tab: tab.id })
      socket = new WebSocket(`${websocketOrigin()}/browser-ws?${query}`)
      socket.binaryType = "arraybuffer"
      socketRef.current = socket
      socket.onopen = () => setConnected(true)
      socket.onclose = () => {
        setConnected(false)
        setControlling(false)
      }
      socket.onmessage = (message) => {
        if (typeof message.data === "string") {
          const parsed = JSON.parse(message.data) as { kind: string; message?: string }
          if (parsed.kind === "error") toast({ title: "Browser", description: parsed.message, tone: "error" })
          return
        }
        void drawFrame(message.data as ArrayBuffer)
      }
    })()
    async function drawFrame(buffer: ArrayBuffer) {
      const view = new DataView(buffer)
      sizeRef.current = { width: view.getUint16(0), height: view.getUint16(2) }
      const bitmap = await createImageBitmap(new Blob([buffer.slice(4)], { type: "image/jpeg" }))
      const canvas = canvasRef.current
      if (!canvas) return bitmap.close()
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width
        canvas.height = bitmap.height
      }
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
      bitmap.close()
    }
    return () => {
      closed = true
      socket?.close()
      socketRef.current = null
    }
  }, [project.id, session, tab.id, toast])

  const send = React.useCallback((message: unknown) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }, [])
  const input = React.useCallback((event: unknown) => send({ kind: "input", event }), [send])

  const toggleControl = () => {
    const take = !controlling
    send({ kind: "control", take })
    setControlling(take)
    if (take) canvasRef.current?.focus()
  }

  /** The page's CSS coordinates under the pointer. */
  const point = (event: React.PointerEvent | React.WheelEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * sizeRef.current.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * sizeRef.current.height),
    }
  }
  const lastMove = React.useRef(0)
  const button = (n: number) => (n === 1 ? "middle" : n === 2 ? "right" : "left")

  const someoneElse = tab.controlledBy !== null && !controlling

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <Button variant="ghost" size="icon-sm" aria-label="Back" disabled={!controlling} onClick={() => input({ type: "history", action: "back" })}>
          <ArrowLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Forward" disabled={!controlling} onClick={() => input({ type: "history", action: "forward" })}>
          <ArrowRightIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Reload" disabled={!controlling} onClick={() => input({ type: "history", action: "reload" })}>
          <RotateCwIcon />
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            editingAddress.current = false
            input({ type: "navigate", url: address })
          }}
        >
          <Input
            value={address}
            readOnly={!controlling}
            onFocus={() => (editingAddress.current = controlling)}
            onBlur={() => (editingAddress.current = false)}
            onChange={(e) => setAddress(e.target.value)}
            aria-label="Address"
            className="h-7 text-xs"
          />
        </form>
        <Button size="sm" variant={controlling ? "default" : "outline"} disabled={!connected || someoneElse} onClick={toggleControl}>
          <HandIcon />
          {controlling ? "Hand back" : "Take control"}
        </Button>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground">
        <span className={cn("size-1.5 rounded-full", connected ? "bg-primary" : "bg-muted-foreground")} />
        <span className="truncate">
          {!connected
            ? "Connecting…"
            : controlling
              ? "You are in control. Agents can read this tab but not act on it."
              : someoneElse
                ? "A person is in control of this tab."
                : tab.busy
                  ? `${agentName(tab.busy)} is working in this tab.`
                  : `Watching ${session} · opened by ${agentName(tab.openedBy)}`}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted p-3">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`Live view of ${tab.title || tab.url}`}
          className={cn(
            "max-h-full max-w-full rounded-md bg-background shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            controlling ? "cursor-default" : "cursor-not-allowed",
          )}
          onContextMenu={(e) => controlling && e.preventDefault()}
          onPointerDown={(e) => {
            if (!controlling) return
            e.currentTarget.focus()
            input({ type: "mouse", action: "down", ...point(e), button: button(e.button), clickCount: Math.min(3, Math.max(1, e.detail)) })
          }}
          onPointerUp={(e) => {
            if (!controlling) return
            input({ type: "mouse", action: "up", ...point(e), button: button(e.button), clickCount: Math.min(3, Math.max(1, e.detail)) })
          }}
          onPointerMove={(e) => {
            if (!controlling || e.timeStamp - lastMove.current < 50) return
            lastMove.current = e.timeStamp
            input({ type: "mouse", action: "move", ...point(e) })
          }}
          onWheel={(e) => controlling && input({ type: "wheel", ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
          onKeyDown={(e) => {
            if (!controlling) return
            e.preventDefault()
            if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return input({ type: "text", text: e.key })
            const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.metaKey && "Meta", e.shiftKey && e.key.length > 1 && "Shift"].filter(Boolean)
            input({ type: "key", action: "press", key: [...mods, e.key].join("+") })
          }}
          onPaste={(e) => {
            if (!controlling) return
            const text = e.clipboardData.getData("text")
            if (text) input({ type: "text", text: text.slice(0, 4000) })
          }}
        />
      </div>
    </section>
  )
}
