"use client"

import * as React from "react"
import { PlusIcon, XIcon } from "lucide-react"

import type { UcchClient } from "@/lib/client"
import { useRealtime } from "@/lib/realtime"
import { useFilesPanel } from "@/components/files-panel"
import { Skeleton } from "@/components/ui/skeleton"
import { XtermPane } from "@/components/xterm-pane"
import { useProjectSessions } from "@/lib/project-sessions"
import { fetchProjectTerminals } from "@/lib/terminal-api"
import { EMPTY_OUTPUT, appendOutput, frameBatcher, type TerminalOutput } from "@/lib/terminal-output"
import { cn } from "@/lib/utils"
import { afterNextPaint, reportVital } from "@/lib/vitals"
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
  /** The session whose worktree the shell runs in; null for the project's checkout. */
  sessionHash: string | null
  /** Bumped when the server replays the tab's output, so its xterm starts afresh. */
  generation: number
}

/** "Terminal N", N one past the highest in use, whichever session opened them. */
function nextTitle(tabs: readonly Tab[]): string {
  let highest = 0
  for (const tab of tabs) {
    const n = /^Terminal (\d+)$/.exec(tab.title)
    if (n) highest = Math.max(highest, Number(n[1]))
  }
  return `Terminal ${highest + 1}`
}

/**
 * Terminals in the project's workspace, one per tab.
 *
 * Each tab is a real pseudo-terminal on the server, running the operator's
 * own login shell in this project's directory and killed when the tab is
 * closed. Because it is a pty rather than a pipe, everything a terminal does
 * works: line editing and completion from the shell itself, colour, ctrl-C,
 * job control, and full-screen programs like vim and top.
 *
 * The tabs are the project's, not the page's: every session of a project
 * shows all of the caller's terminals in it, whichever session opened them
 * (each still runs in that session's worktree, which its tab names). Leaving
 * a session -- or reloading -- only stops watching them; coming back lists
 * them again (`GET /api/projects/:id/terminals`) and the server replays
 * each one's recent output. Only closing a tab ends its shell.
 *
 * This component owns the socket, the tabs and the output; the drawing is
 * xterm.js, in `XtermPane`.
 */
export function TerminalView({ project, active }: { project: Project; active: boolean }) {
  const [tabs, setTabs] = React.useState<Tab[]>([])
  const [activeId, setActiveId] = React.useState<string | null>(null)
  const [output, setOutput] = React.useState<Record<string, TerminalOutput>>({})
  const [ready, setReady] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  /** The project's terminal limit and how many are open, every member's; null until listed. */
  const [room, setRoom] = React.useState<{ limit: number; open: number } | null>(null)
  /** Whether the server's list has been read since mounting: until then, no first shell. */
  const [listed, setListed] = React.useState(false)
  // Ids the server has listed, so a later list without one says it ended --
  // while the socket was down, say -- and an id just opened is not dropped
  // before the server has it.
  const knownRef = React.useRef(new Set<string>())
  const { sessions } = useProjectSessions(project)

  const clientRef = React.useRef<UcchClient | null>(null)
  const unsubscribeRef = React.useRef<() => void>(() => {})
  // The tabs as they are now, for the teardown below: an effect keyed on the
  // project would otherwise close the tabs it knew at mount -- none.
  const tabsRef = React.useRef(tabs)
  tabsRef.current = tabs
  const { registerTerminals, commandRun } = useFilesPanel()
  // The last command button run here, so a re-render does not run it again.
  // Zero at mount: the click that first opens the view is one to run.
  const ranRef = React.useRef(0)
  /**
   * keystroke-to-echo (lib/vitals.ts): a printable key sent to a shell, to
   * the paint after the output that follows it. One key at a time; a key
   * nothing answered (a password prompt) gives way after a few seconds.
   */
  const echoRef = React.useRef<{ terminalId: string; at: number; answered: boolean } | null>(null)

  /** Forgets a tab that has ended, wherever it was closed. */
  const drop = React.useCallback((id: string) => {
    clientRef.current?.unsubscribe({ name: "terminal", terminalId: id })
    knownRef.current.delete(id)
    setTabs((current) => {
      if (!current.some((tab) => tab.id === id)) return current
      const remaining = current.filter((tab) => tab.id !== id)
      setActiveId((currentActive) => (currentActive === id ? (remaining.at(-1)?.id ?? null) : currentActive))
      return remaining
    })
    setOutput((current) => {
      if (!(id in current)) return current
      const { [id]: _gone, ...rest } = current
      return rest
    })
  }, [])

  /**
   * The socket opens the first time the terminal is looked at, not when the
   * project page loads: most visits never open a shell, and a connection for
   * a view nobody opened is a connection wasted.
   *
   * Once open it stays open until the view unmounts, whatever `active` does
   * afterwards. The shells outlive the socket on the server, so closing it
   * when the user glanced at the chat would leave the tabs pointing at
   * shells nothing is subscribed to any more: the prompt still on screen,
   * every keystroke swallowed. Which is exactly the "can't type" that used
   * to happen after switching views.
   */
  // The tab's one socket (lib/realtime.tsx), not one of the terminal's own.
  const { client: shared } = useRealtime()
  React.useEffect(() => {
    if (!active || clientRef.current || !shared) return

    const client = shared
    clientRef.current = client

    // Output arrives as transient events on the terminal topics this client
    // is subscribed to, straight from the socket rather than through
    // `client.events`, and is folded in about once a frame.
    const batch = frameBatcher<{ terminalId: string; data: string }>((items) => {
      const next: Record<string, string[]> = {}
      // Kept as separate chunks, in order, so the pane can tell which it
      // has not written yet.
      for (const item of items) (next[item.terminalId] ??= []).push(item.data)
      setOutput((current) => {
        const merged = { ...current }
        for (const [id, chunks] of Object.entries(next)) {
          merged[id] = appendOutput(merged[id] ?? EMPTY_OUTPUT, chunks, MAX_CHUNKS)
        }
        return merged
      })
      // xterm draws what this commit hands it on the next animation frame.
      const echo = echoRef.current
      if (echo?.answered) {
        echoRef.current = null
        afterNextPaint(() => reportVital("keystroke-to-echo", performance.now() - echo.at))
      }
    })
    const offState = client.subscribeToChanges(() => setReady(client.state === "ready"))
    const offEvents = client.onEvent(({ event }) => {
      if (event.type === "terminal.closed") {
        // Closed in another page, exited, or reaped: the tab goes everywhere.
        drop(event.terminalId)
        return
      }
      if (event.type !== "terminal.output") return
      if (event.replay) {
        // A shell already running, as this page attaches to it: what it
        // printed recently replaces whatever the tab held, on a fresh xterm.
        const id = event.terminalId
        setOutput((current) => ({ ...current, [id]: appendOutput(EMPTY_OUTPUT, [event.data], MAX_CHUNKS) }))
        setTabs((current) => current.map((tab) => (tab.id === id ? { ...tab, generation: tab.generation + 1 } : tab)))
        return
      }
      if (echoRef.current?.terminalId === event.terminalId) echoRef.current.answered = true
      batch.push({ terminalId: event.terminalId, data: event.data })
    })
    unsubscribeRef.current = () => {
      offState()
      offEvents()
      batch.cancel()
    }

    setReady(client.state === "ready")

    // No cleanup here: this effect re-runs when `active` flips, and a
    // cleanup would drop the shells' output on every switch away. Closing
    // is the project effect's job below.
  }, [active, project.id, shared, drop])

  // Leaving the session, or the project, only stops watching the shells:
  // they run on, every session of the project lists them, and the server
  // closes one nobody watches only after its idle time.
  React.useEffect(() => {
    return () => {
      const client = clientRef.current
      if (!client) return
      for (const tab of tabsRef.current) client.unsubscribe({ name: "terminal", terminalId: tab.id })
      unsubscribeRef.current()
      clientRef.current = null
      knownRef.current = new Set()
      setTabs([])
      setActiveId(null)
      setOutput({})
      setRoom(null)
      setListed(false)
      setReady(false)
    }
  }, [project.id])

  /**
   * Brings the tabs in line with the project's running terminals: a tab for
   * each one this page does not show yet -- opened in another session, or
   * before a reload -- subscribed to, which has the server replay it; and
   * none for one that ended unseen.
   */
  const sync = React.useCallback(async () => {
    const client = clientRef.current
    if (!client) return
    let listing
    try {
      listing = await fetchProjectTerminals(project.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setListed(true)
      return
    }
    if (clientRef.current !== client) return
    setRoom({ limit: listing.limit, open: listing.open })
    const running = new Set(listing.terminals.map((t) => t.id))
    for (const id of knownRef.current) if (!running.has(id)) drop(id)
    const shown = new Set(tabsRef.current.map((tab) => tab.id))
    const added: Tab[] = []
    for (const terminal of listing.terminals) {
      knownRef.current.add(terminal.id)
      if (shown.has(terminal.id)) continue
      added.push({ id: terminal.id, title: terminal.label, sessionHash: terminal.sessionHash, generation: 0 })
      void client.subscribe({ name: "terminal", terminalId: terminal.id }).catch(() => {})
    }
    if (added.length > 0) {
      setTabs((current) => [...current, ...added.filter((tab) => !current.some((t) => t.id === tab.id))])
      setOutput((current) => {
        const next = { ...current }
        for (const tab of added) next[tab.id] ??= EMPTY_OUTPUT
        return next
      })
      // The newest of this session's own, else the newest of all.
      const mine = added.filter((tab) => tab.sessionHash === (project.sessionHash ?? null))
      setActiveId((current) => current ?? (mine.at(-1) ?? added.at(-1))!.id)
    }
    setListed(true)
  }, [project.id, project.sessionHash, drop])

  // Listed when the view is first looked at and whenever the socket is back
  // -- a reconnect may have missed a tab opened or closed meanwhile -- and
  // again when the browser tab regains focus, for one opened elsewhere.
  React.useEffect(() => {
    if (!active || !ready) return
    void sync()
    const onFocus = () => void sync()
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [active, ready, sync])

  const full = room !== null && room.open >= room.limit

  const open = React.useCallback(async (command?: { commandId: string; label: string }) => {
    const client = clientRef.current
    if (!client) return

    const id = crypto.randomUUID()
    const title = command?.label ?? nextTitle(tabsRef.current)
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
        // A project session's shell opens in its own worktree.
        ...(project.sessionHash ? { sessionHash: project.sessionHash } : {}),
        // A command button: the server reads its command line from the project's file.
        ...(command ? { program: "command" as const, commandId: command.commandId } : {}),
        // What every session's tab strip calls it.
        label: title.slice(0, 60),
      })
      setTabs((current) => [...current, { id, title, sessionHash: project.sessionHash ?? null, generation: 0 }])
      setActiveId(id)
      setOutput((current) => ({ ...current, [id]: EMPTY_OUTPUT }))
      setRoom((current) => current && { ...current, open: current.open + 1 })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [project.id, project.sessionHash])

  // A command button clicked in the header: a tab of its own, once.
  const pendingCommand =
    commandRun && commandRun.projectId === project.id && commandRun.token !== ranRef.current ? commandRun : null
  React.useEffect(() => {
    if (!ready || !pendingCommand) return
    ranRef.current = pendingCommand.token
    void open({ commandId: pendingCommand.commandId, label: pendingCommand.label })
  }, [ready, pendingCommand, open])

  // One shell to begin with, so the view is usable the moment it opens --
  // once the server has said the project has none of the caller's running,
  // and unless a command button is about to open the first tab itself or
  // the project has no room for another.
  React.useEffect(() => {
    if (!active || !ready || !listed || tabs.length > 0 || pendingCommand || full) return
    void open()
  }, [active, ready, listed, tabs.length, open, pendingCommand, full])

  /** Ends a tab's shell, in every session showing it. */
  function close(id: string) {
    void clientRef.current?.dispatch({ type: "terminal.close", terminalId: id }).catch(() => {})
    if (knownRef.current.has(id) || tabsRef.current.some((tab) => tab.id === id)) {
      setRoom((current) => current && { ...current, open: Math.max(0, current.open - 1) })
    }
    drop(id)
  }

  // Kills every shell at once -- all of the caller's in the project, from
  // every session. A fresh one opens by itself afterwards, the same way the
  // view started, so closing all is never a dead end.
  const closeAll = React.useCallback(() => {
    const client = clientRef.current
    for (const tab of tabs) {
      void client?.dispatch({ type: "terminal.close", terminalId: tab.id }).catch(() => {})
      client?.unsubscribe({ name: "terminal", terminalId: tab.id })
    }
    knownRef.current = new Set()
    setRoom((current) => current && { ...current, open: Math.max(0, current.open - tabs.length) })
    setTabs([])
    setActiveId(null)
    setOutput({})
  }, [tabs])

  /** Which session's worktree a tab runs in, when it is not this one's. */
  function originOf(tab: Tab): string | null {
    const here = project.sessionHash ?? null
    if (tab.sessionHash === here) return null
    if (tab.sessionHash === null) return "main checkout"
    const session = sessions?.find((s) => (s.treeHash ?? s.hash) === tab.sessionHash)
    return session?.title || tab.sessionHash.slice(0, 8)
  }

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
    const now = performance.now()
    const waiting = echoRef.current
    if (data.length === 1 && data >= " " && data !== "\x7f" && (!waiting || now - waiting.at > 5_000)) {
      echoRef.current = { terminalId: id, at: now, answered: false }
    }
    clientRef.current?.terminalInput(id, data)
  }

  /**
   * Tells the pty the screen's real size.
   *
   * Without this the shell believes it is 80x24 whatever the pane is, and
   * everything that draws a full screen -- an editor, a pager, a progress
   * bar -- wraps against a width that is not there.
   */
  function resize(id: string, cols: number, rows: number) {
    clientRef.current?.terminalResize(id, cols, rows)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The tab strip, with the new-terminal button after the last tab --
          where a browser puts it, and where the next one will appear. */}
      <div
        role="tablist"
        className="no-scrollbar flex h-10 shrink-0 items-center gap-px overflow-x-auto border-b"
      >
        {tabs.map((tab) => {
          const origin = originOf(tab)
          return (
          <div
            key={tab.id}
            title={origin ? `Opened in ${origin}; runs in its worktree` : undefined}
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
              // A click must not leave focus on the tab itself: the pane
              // takes it as it is shown, and a focused button would keep it
              // away from the shell the user just asked for.
              onMouseDown={(event) => event.preventDefault()}
              className="flex items-center gap-1.5 outline-hidden"
            >
              {tab.title}
              {origin && (
                <span className="bg-muted text-muted-foreground max-w-32 truncate rounded px-1 text-[10px] leading-4">
                  {origin}
                </span>
              )}
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
          )
        })}

        <button
          type="button"
          onClick={() => void open()}
          disabled={!ready || full}
          title={full ? `This project has ${room!.limit} terminals open, its limit` : "New terminal"}
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

      {tabs.length === 0 && ready && !listed ? (
        // Listing the project's running terminals: a pane's worth of lines,
        // rather than "no terminal open" flashing before they arrive.
        <div className="flex flex-1 flex-col gap-2 p-4" aria-hidden>
          {[60, 40, 75, 30].map((w) => (
            <Skeleton key={w} className="h-3" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : tabs.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center p-8 text-sm">
          {!ready
            ? "Connecting…"
            : full
              ? `This project already has ${room!.limit} terminals open, its limit. Close one in another session to open one here.`
              : "No terminal open. Use + to start one."}
        </div>
      ) : (
        tabs.map((tab) => (
          <XtermPane
            // A replay starts the pane afresh rather than writing over what it drew.
            key={`${tab.id}:${tab.generation}`}
            // Hidden when the whole view is, too: a pane that only knew about
            // its own tab would not refit or refocus when the user switches
            // from the file browser back to the terminal.
            hidden={!active || tab.id !== activeId}
            data={output[tab.id] ?? EMPTY_OUTPUT}
            onInput={(data) => send(tab.id, data)}
            onResize={(cols, rows) => resize(tab.id, cols, rows)}
          />
        ))
      )}
    </div>
  )
}
