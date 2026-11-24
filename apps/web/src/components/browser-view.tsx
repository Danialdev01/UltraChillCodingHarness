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
import { AnnotationLayer, annotatedFile } from "@/components/browser-annotate"
import { BrowserToolbar, type BrowserTool } from "@/components/browser-toolbar"
import { NewBrowserTabDialog } from "@/components/new-browser-tab-dialog"
import { BrowserViewSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  captureBrowserTab,
  closeBrowserTab,
  fetchProjectBrowser,
  openBrowserTab,
  tabsOfSession,
  type BrowserCapture,
  type BrowserSessionInfo,
  type BrowserTabInfo,
} from "@/lib/browser-api"
import { annotationPrompt } from "@/lib/browser-annotate"
import { websocketOrigin } from "@/lib/client"
import { EMPTY_HISTORY, PEN_COLORS, redo, undo, type History } from "@/lib/image-annotate"
import { useProjectSessions } from "@/lib/project-sessions"
import { qk } from "@/lib/query-keys"
import { useProjectEvents, useToast } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"

type Selection = { session: string; tab: string }

/**
 * The agents' shared browser, live.
 *
 * "+" opens a tab for this chat session (`threadId`), whose agent may use
 * it at once. The bar over the page marks it up for the chat.
 *
 * Every session of the project -- each agent's private one and the named
 * ones agents share -- with its tabs on the left; the chosen tab streams on
 * the right. Watching changes nothing. "Take control" makes the tab yours:
 * clicks, keys and the address bar reach the page, and agents may still
 * read it but not act on it until you hand it back (or leave).
 */
export function BrowserView({
  project,
  threadId,
  onReference,
}: {
  project: Project
  threadId: string | null
  /** A marked-up page for the composer. */
  onReference: (text: string, file: File) => void
}) {
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
  const [adding, setAdding] = React.useState(false)
  // This chat's own tabs first.
  const sessions = React.useMemo(
    () => [...(data?.sessions ?? [])].sort((a, b) => Number(b.owner !== null && b.owner === threadId) - Number(a.owner !== null && a.owner === threadId)),
    [data?.sessions, threadId],
  )
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

  const open = tabsOfSession(sessions, threadId)
  const full = open >= data.maxTabs

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-1.5 pl-3 text-sm">
          <span className="font-medium">Tabs</span>
          <span className="text-muted-foreground text-xs tabular-nums" title="Open in this session, and the most it may have">
            {open}/{data.maxTabs}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="New tab"
            title={full ? `This session has all ${data.maxTabs} of its tabs open. Close one, or raise the limit in Settings.` : "New tab"}
            disabled={full}
            onClick={() => setAdding(true)}
          >
            <PlusIcon />
          </Button>
          <NewBrowserTabDialog
            open={adding}
            onOpenChange={setAdding}
            onOpen={async (url, name) => {
              const opened = await openBrowserTab(project.hash, threadId, url, name)
              await queryClient.invalidateQueries({ queryKey: qk.browser.all })
              setSelected(opened)
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No browser sessions yet. Agents open tabs with <code>browser_open</code>; open one yourself with +.
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
      </aside>
      {current ? (
        <LiveTab key={`${selected!.session}/${selected!.tab}`} project={project} session={selected!.session} tab={current} agentName={agentName} onReference={onReference} />
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
            <button type="button" className="min-w-0 flex-1 text-left" title={tab.url} onClick={() => onSelect(tab.id)}>
              <div className="flex items-center gap-1.5">
                {tab.busy && !tab.controlledBy && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="An agent is acting" />}
                <span className="truncate text-sm">{tab.name || tab.title || hostOf(tab.url) || "New tab"}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {tab.controlledBy ? "A person is in control" : `Opened by ${agentName(tab.openedBy)}`}
              </div>
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.name || tab.title || tab.id}`}
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

/** Marks not sent yet, per tab: looking at another tab or at the chat does not lose them. */
type Annotation = { capture: BrowserCapture; history: History; tool: Exclude<BrowserTool, "live"> }
const unsent = new Map<string, Annotation>()

/** One tab's frames, and a person's input while they have control. */
function LiveTab({
  project,
  session,
  tab,
  agentName,
  onReference,
}: {
  project: Project
  session: string
  tab: BrowserTabInfo
  agentName: (id: string) => string
  onReference: (text: string, file: File) => void
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

  const draftKey = `${project.id}/${session}/${tab.id}`
  const [annotation, setAnnotation] = React.useState<Annotation | null>(() => unsent.get(draftKey) ?? null)
  React.useEffect(() => {
    // Only marks are worth keeping: an unmarked capture would just be stale.
    if (annotation?.history.ops.length) unsent.set(draftKey, annotation)
    else unsent.delete(draftKey)
  }, [annotation, draftKey])
  const [color, setColor] = React.useState<string>(PEN_COLORS[0].value)
  const [widthIndex, setWidthIndex] = React.useState<"0" | "1" | "2">("0")
  const [capturing, setCapturing] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [discarding, setDiscarding] = React.useState<"live" | "retake" | null>(null)
  const tool: BrowserTool = annotation?.tool ?? "live"
  const marked = (annotation?.history.ops.length ?? 0) > 0
  const setHistory = (update: (history: History) => History) =>
    setAnnotation((a) => (a ? { ...a, history: update(a.history) } : a))

  async function capture(next: Exclude<BrowserTool, "live">) {
    setCapturing(true)
    try {
      const taken = await captureBrowserTab(project.hash, session, tab.id)
      setAnnotation(() => ({ capture: taken, history: EMPTY_HISTORY, tool: next }))
    } catch (e) {
      toast({ title: "Could not capture the page", description: (e as Error).message, tone: "error" })
    } finally {
      setCapturing(false)
    }
  }
  function chooseTool(next: BrowserTool) {
    setDiscarding(null)
    if (next === "live") {
      if (marked) setDiscarding("live")
      else setAnnotation(() => null)
    } else if (annotation) setAnnotation((a) => (a ? { ...a, tool: next } : a))
    else void capture(next)
  }
  function retake() {
    if (!annotation) return
    if (marked) setDiscarding("retake")
    else void capture(annotation.tool)
  }
  function discard() {
    const what = discarding
    setDiscarding(null)
    if (what === "retake" && annotation) void capture(annotation.tool)
    else setAnnotation(() => null)
  }
  async function sendToChat() {
    if (!annotation) return
    setSending(true)
    try {
      const { capture: taken, history } = annotation
      const file = await annotatedFile(taken, history.ops)
      const text = annotationPrompt(taken, history.ops, { session, tab: tab.id, name: tab.name })
      unsent.delete(draftKey)
      setAnnotation(() => null)
      onReference(text, file)
    } catch (e) {
      toast({ title: "Could not add it to the chat", description: (e as Error).message, tone: "error" })
    } finally {
      setSending(false)
    }
  }
  function onHistoryKey(event: React.KeyboardEvent) {
    if (!annotation || event.target instanceof HTMLInputElement || !(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (key !== "z" && key !== "y") return
    event.preventDefault()
    setHistory(key === "y" || event.shiftKey ? redo : undo)
  }

  const someoneElse = tab.controlledBy !== null && !controlling

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onHistoryKey}>
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
            : annotation
              ? `Marking up a capture of this page. ${annotation.tool === "element" ? "Click an element to pin it." : annotation.tool === "text" ? "Click where the note goes." : "Drag to draw."}`
            : controlling
              ? "You are in control. Agents can read this tab but not act on it."
              : someoneElse
                ? "A person is in control of this tab."
                : tab.busy
                  ? `${agentName(tab.busy)} is working in this tab.`
                  : `Watching ${session} · opened by ${agentName(tab.openedBy)}`}
        </span>
      </div>
      <BrowserToolbar
        tool={tool}
        onTool={chooseTool}
        color={color}
        onColor={setColor}
        widthIndex={widthIndex}
        onWidthIndex={setWidthIndex}
        canUndo={marked}
        canRedo={(annotation?.history.undone.length ?? 0) > 0}
        onUndo={() => setHistory(undo)}
        onRedo={() => setHistory(redo)}
        onClear={() => setHistory((h) => ({ ops: [], undone: [...h.undone, ...[...h.ops].reverse()] }))}
        onRetake={retake}
        viewport={annotation?.capture.viewport ?? tab.viewport}
        onResize={(width, height) => send({ kind: "resize", width, height })}
        connected={connected && !someoneElse}
        busy={capturing}
        onSend={() => void sendToChat()}
        sending={sending}
      />
      {discarding && (
        <div role="alert" className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
          <span className="truncate">Discard the marks on this page?</span>
          <Button size="sm" variant="destructive" className="ml-auto" onClick={discard}>
            Discard
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDiscarding(null)}>
            Keep
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted p-3">
        {annotation && (
          <AnnotationLayer
            capture={annotation.capture}
            tool={annotation.tool}
            color={color}
            widthIndex={widthIndex}
            history={annotation.history}
            onHistory={setHistory}
          />
        )}
        <canvas
          ref={canvasRef}
          tabIndex={0}
          aria-label={`Live view of ${tab.title || tab.url}`}
          className={cn(
            annotation && "hidden",
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
