"use client"

import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal, type ITheme } from "@xterm/xterm"

import "@xterm/xterm/css/xterm.css"

import type { UcchClient } from "@/lib/client"
import { openSshTerminal } from "@/lib/ssh-api"

/** What a pane says about its shell, for its header. */
export type SessionStatus = "connecting" | "open" | "exited" | "failed"

interface Session {
  paneId: string
  hostId: string
  terminalId: string
  /** The element xterm draws into. Moved between slots, never rebuilt. */
  element: HTMLDivElement
  term: Terminal
  fit: FitAddon
  opened: boolean
  status: SessionStatus
  error: string | null
}

interface Listeners {
  /** A pane's shell changed state. */
  status: (paneId: string, status: SessionStatus, error: string | null) => void
  /** The text selected in a pane, "" when it goes. */
  selection: (paneId: string, text: string) => void
  /** A pane took the keyboard. */
  focus: (paneId: string) => void
}

/**
 * The Terminal page's shells, outside React.
 *
 * Each pane's xterm lives in an element of its own that is created once and
 * *moved* between slots: splitting a pane puts it in a new place in the
 * layout tree, and a component tree would rebuild it there -- a fresh
 * terminal, a fresh shell, the scrollback gone. Here the slot only adopts
 * the element (`attach`) and lets go of it (`detach`); the session ends
 * only when its pane is closed (`dispose`).
 *
 * Output is written straight into xterm from the socket's events, so a
 * busy shell never renders anything in React.
 */
export class TerminalSessions {
  readonly #sessions = new Map<string, Session>()
  readonly #byTerminal = new Map<string, Session>()
  #theme: ITheme
  #offEvents: () => void

  constructor(
    private readonly client: UcchClient,
    theme: ITheme,
    private readonly listeners: Listeners,
  ) {
    this.#theme = theme
    this.#offEvents = client.onEvent(({ event }) => {
      if (event.type !== "terminal.output") return
      const session = this.#byTerminal.get(event.terminalId)
      if (!session) return
      session.term.write(event.data)
      if (session.status === "connecting") this.#setStatus(session, "open", null)
      if (event.data.includes("[exited with")) this.#setStatus(session, "exited", null)
    })
  }

  has(paneId: string): boolean {
    return this.#sessions.has(paneId)
  }

  statusOf(paneId: string): { status: SessionStatus; error: string | null } | null {
    const session = this.#sessions.get(paneId)
    return session ? { status: session.status, error: session.error } : null
  }

  /** The pane's session, started on first use. */
  ensure(paneId: string, hostId: string): void {
    const existing = this.#sessions.get(paneId)
    if (existing && existing.hostId === hostId) return
    if (existing) this.dispose(paneId)

    const element = document.createElement("div")
    element.className = "h-full w-full"
    const term = new Terminal({
      theme: this.#theme,
      fontFamily: "var(--app-font-mono), ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10_000,
      convertEol: false,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    const session: Session = {
      paneId,
      hostId,
      terminalId: crypto.randomUUID(),
      element,
      term,
      fit,
      opened: false,
      status: "connecting",
      error: null,
    }
    this.#sessions.set(paneId, session)
    this.#byTerminal.set(session.terminalId, session)

    term.onData((data) => this.client.terminalInput(session.terminalId, data))
    term.onResize(({ cols, rows }) => this.client.terminalResize(session.terminalId, cols, rows))
    term.onSelectionChange(() => this.listeners.selection(paneId, term.getSelection()))
    void this.#start(session)
  }

  /** Puts a pane's screen into `slot`, opening xterm there the first time. */
  attach(paneId: string, slot: HTMLElement): void {
    const session = this.#sessions.get(paneId)
    if (!session) return
    if (session.element.parentElement !== slot) slot.appendChild(session.element)
    if (!session.opened) {
      session.term.open(session.element)
      session.opened = true
      session.term.textarea?.addEventListener("focus", () => this.listeners.focus(paneId))
    }
    this.fit(paneId)
  }

  /** Takes a pane's screen out of `slot`, if it is still there; the shell runs on. */
  detach(paneId: string, slot: HTMLElement): void {
    const session = this.#sessions.get(paneId)
    if (session && session.element.parentElement === slot) slot.removeChild(session.element)
  }

  fit(paneId: string): void {
    const session = this.#sessions.get(paneId)
    if (!session?.opened || !session.element.isConnected) return
    try {
      session.fit.fit()
    } catch {
      // A zero-sized slot throws; the next observation has real numbers.
    }
  }

  focus(paneId: string): void {
    this.#sessions.get(paneId)?.term.focus()
  }

  /** Types `text` into a pane's shell, as a paste would. */
  paste(paneId: string, text: string): void {
    const session = this.#sessions.get(paneId)
    if (!session) return
    session.term.paste(text)
    session.term.focus()
  }

  clearSelection(paneId: string): void {
    this.#sessions.get(paneId)?.term.clearSelection()
  }

  /** Reconnects a pane whose shell ended or never started: a new shell, the old screen kept. */
  restart(paneId: string): void {
    const session = this.#sessions.get(paneId)
    if (!session) return
    this.#stop(session)
    this.#byTerminal.delete(session.terminalId)
    session.terminalId = crypto.randomUUID()
    this.#byTerminal.set(session.terminalId, session)
    session.term.write("\r\n")
    void this.#start(session)
  }

  setTheme(theme: ITheme): void {
    this.#theme = theme
    for (const session of this.#sessions.values()) session.term.options.theme = theme
  }

  /** Ends a pane's shell and forgets it. */
  dispose(paneId: string): void {
    const session = this.#sessions.get(paneId)
    if (!session) return
    this.#sessions.delete(paneId)
    this.#byTerminal.delete(session.terminalId)
    this.#stop(session)
    session.term.dispose()
    session.element.remove()
  }

  /** Every session that is not in `keep`: the panes that were closed. */
  disposeExcept(keep: ReadonlySet<string>): void {
    for (const paneId of [...this.#sessions.keys()]) if (!keep.has(paneId)) this.dispose(paneId)
  }

  destroy(): void {
    for (const paneId of [...this.#sessions.keys()]) this.dispose(paneId)
    this.#offEvents()
  }

  async #start(session: Session): Promise<void> {
    this.#setStatus(session, "connecting", null)
    const { terminalId } = session
    try {
      // Watched before it starts: the first thing a shell prints is the
      // login banner, and a subscription made afterwards would miss it.
      await this.client.subscribe({ name: "terminal", terminalId })
      await openSshTerminal(session.hostId, terminalId, session.term.cols, session.term.rows)
    } catch (error) {
      if (session.terminalId !== terminalId) return
      const message = error instanceof Error ? error.message : String(error)
      session.term.write(`\x1b[31m${message}\x1b[0m\r\n`)
      this.#setStatus(session, "failed", message)
    }
  }

  #stop(session: Session): void {
    void this.client.dispatch({ type: "terminal.close", terminalId: session.terminalId }).catch(() => {})
    this.client.unsubscribe({ name: "terminal", terminalId: session.terminalId })
  }

  #setStatus(session: Session, status: SessionStatus, error: string | null): void {
    if (session.status === status && session.error === error) return
    session.status = status
    session.error = error
    this.listeners.status(session.paneId, status, error)
  }
}
