"use client"

import * as React from "react"
import { PlusIcon, XIcon } from "lucide-react"

import { UcchClient } from "@/lib/client"
import { useFilesPanel } from "@/components/files-panel"
import { XtermPane } from "@/components/xterm-pane"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/session"

/**
 * Chunks buffered per tab before the oldest are dropped.
 *
 * Only a backstop against unbounded memory: the scrollback a reader actually
 * scrolls through is xterm's own, and it keeps its own ten thousand lines.
 */
const MAX_CHUNKS = 2_000

interface Tab {
  id: string
  title: string
}

/** A stable empty array, so a tab with no output yet does not rewrite on every render. */
const EMPTY: readonly string[] = []

/**
 * Terminals in the project's workspace, one per tab.
 *
 * Each tab is a real pseudo-terminal on the server, running the operator's
 * own login shell in this project's directory and killed when the tab is
 * closed. Because it is a pty rather than a pipe, everything a terminal does
 * works: line editing and completion from the shell itself, colour, ctrl-C,
 * job control, and full-screen programs like vim and top.
 *
 * This component owns the socket, the tabs and the output; the drawing is
 * xterm.js, in `XtermPane`.
 */
export function TerminalView({ project, active }: { project: Project; active: boolean }) {
  const [tabs, setTabs] = React.useState<Tab[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [output, setOutput] = React.useState<Record<string, readonly string[]>>({})
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const clientRef = React.useRef<UcchClient | null>(null)
  const seen = React.useRef(0)
  const { registerTerminals } = useFilesPanel()

  /**
   * The socket opens the first time the terminal is looked at, not when the
   * project page loads: most visits never open a shell, and a connection for
   * a view nobody opened is a connection wasted.
   */
  React.useEffect(() => {
    if (!active || clientRef.current) return

    const client = new UcchClient()
    clientRef.current = client

    const unsubscribe = client.subscribeToChanges(() => {
      setReady(client.state === "ready")
      // Output arrives as transient events on the terminal topics this client
      // is subscribed to. Only what has not been folded in yet.
      const events = client.events
      if (seen.current >= events.length) return
      const next: Record<string, string[]> = {}
      for (let i = seen.current; i < events.length; i++) {
        const event = events[i]!.event
        if (event.type !== "terminal.output") continue
        // Kept as separate chunks, in order: the pane writes the ones it has
        // not seen, and joining them here would make that impossible to tell.
        ;(next[event.terminalId] ??= []).push(event.data)
      }
      seen.current = events.length
      if (Object.keys(next).length === 0) return

      setOutput((current) => {
        const merged = { ...current }
        for (const [id, chunks] of Object.entries(next)) {
          merged[id] = [...(merged[id] ?? []), ...chunks].slice(-MAX_CHUNKS)
        }
        return merged
      })
    })

    void client.connect().catch(() => setError("Could not reach the server."))

    return () => {
      unsubscribe()
      client.close()
      clientRef.current = null
    }
  }, [active, project.id])

  // The shells belong to a project, so leaving it closes them rather than
  // leaving a bash running for a page nobody has open.
  React.useEffect(() => {
    return () => {
      const client = clientRef.current
      if (!client) return
      for (const tab of tabs) {
        void client.dispatch({ type: "terminal.close", terminalId: tab.id }).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const open = React.useCallback(async () => {
    const client = clientRef.current
    if (!client) return

    const id = crypto.randomUUID()
    setError(null)
    try {
      // Subscribed before the shell starts: the first thing it prints is its
      // prompt, and a subscription made afterwards would miss it.
      await client.subscribe({ name: "terminal", terminalId: id })
      await client.dispatch({
        type: "terminal.create",
        projectId: project.id,
        terminalId: id,
        cols: 120,
        rows: 30,
      })
      setTabs((current) => [...current, { id, title: `Terminal ${current.length + 1}` }])
      setActiveId(id)
      setOutput((current) => ({ ...current, [id]: [] }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [project.id])

  // One shell to begin with, so the view is usable the moment it opens.
  React.useEffect(() => {
    if (!active || !ready || tabs.length > 0) return
    void open()
  }, [active, ready, tabs.length, open])

  function close(id: string) {
    const client = clientRef.current
    void client?.dispatch({ type: "terminal.close", terminalId: id }).catch(() => {})
    setTabs((current) => {
      const remaining = current.filter((tab) => tab.id !== id)
      setActiveId((currentActive) =>
        currentActive === id ? (remaining.at(-1)?.id ?? null) : currentActive,
      )
      return remaining
    })
    setOutput((current) => {
      const { [id]: _gone, ...rest } = current
      return rest
    })
  }

  // Kills every shell at once. A fresh one opens by itself afterwards, the
  // same way the view started, so closing all is never a dead end.
  const closeAll = React.useCallback(() => {
    const client = clientRef.current
    for (const tab of tabs) {
      void client?.dispatch({ type: "terminal.close", terminalId: tab.id }).catch(() => {})
    }
    setTabs([])
    setActiveId(null)
    setOutput({})
  }, [tabs])

  // The header's close-all button lives outside this view, so the count and
  // the act are handed up to the shell.
  React.useEffect(() => {
    registerTerminals({ count: tabs.length, closeAll })
  }, [registerTerminals, tabs.length, closeAll])
  React.useEffect(
    () => () => registerTerminals({ count: 0, closeAll: () => {} }),
    [registerTerminals],
  )

  function send(id: string, data: string) {
    void clientRef.current
      ?.dispatch({ type: "terminal.input", terminalId: id, data })
      .catch(() => {})
  }

  /**
   * Tells the pty the screen's real size.
   *
   * Without this the shell believes it is 80x24 whatever the pane is, and
   * everything that draws a full screen -- an editor, a pager, a progress
   * bar -- wraps against a width that is not there.
   */
  function resize(id: string, cols: number, rows: number) {
    void clientRef.current
      ?.dispatch({ type: "terminal.resize", terminalId: id, cols, rows })
      .catch(() => {})
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The tab strip, with the new-terminal button after the last tab --
          where a browser puts it, and where the next one will appear. */}
      <div
        role="tablist"
        className="no-scrollbar flex h-10 shrink-0 items-center gap-px overflow-x-auto border-b"
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "group/tab flex h-full shrink-0 items-center gap-2 border-r pr-1 pl-3 text-sm",
              tab.id === activeId
                ? "border-b-ucch-active bg-background text-ucch-active border-b-2"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === activeId}
              onClick={() => setActiveId(tab.id)}
              className="outline-hidden"
            >
              {tab.title}
            </button>
            <button
              type="button"
              onClick={() => close(tab.id)}
              className={cn(
                "hover:bg-muted rounded-sm p-0.5 opacity-0 group-hover/tab:opacity-100",
                tab.id === activeId && "opacity-100",
              )}
            >
              <XIcon className="size-3.5" />
              <span className="sr-only">Close {tab.title}</span>
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={() => void open()}
          disabled={!ready}
          title="New terminal"
          className="text-muted-foreground hover:bg-muted/50 hover:text-foreground ml-1 flex size-7 shrink-0 items-center justify-center rounded-md disabled:opacity-40"
        >
          <PlusIcon className="size-4" />
          <span className="sr-only">New terminal</span>
        </button>
      </div>

      {error && (
        <p role="alert" className="text-destructive border-b px-4 py-2 text-xs">
          {error}
        </p>
      )}

      {tabs.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
          {ready ? "No terminal open. Use + to start one." : "Connecting…"}
        </div>
      ) : (
        tabs.map((tab) => (
          <XtermPane
            key={tab.id}
            hidden={tab.id !== activeId}
            data={output[tab.id] ?? EMPTY}
            onInput={(data) => send(tab.id, data)}
            onResize={(cols, rows) => resize(tab.id, cols, rows)}
          />
        ))
      )}
    </div>
  )
}
