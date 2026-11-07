"use client"

import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { XtermPane } from "@/components/xterm-pane"
import type { UcchClient } from "@/lib/client"
import { useRealtime } from "@/lib/realtime"
import { EMPTY_OUTPUT, appendOutput, frameBatcher, type TerminalOutput } from "@/lib/terminal-output"

export type LoginProgram = "claude-login" | "codex-login"

/** Chunks kept per session; the pane's own scrollback is the real buffer. */
const MAX_CHUNKS = 2_000

export type LoginTerminalStatus = "connecting" | "running" | "exited" | "error"

/**
 * One run of a provider's sign-in CLI on the server, in a PTY.
 *
 * The server cannot open your browser and your browser cannot reach a
 * callback on the server, so the CLIs fall back to the code-paste flow they
 * ship for exactly this case. The credential lands in a directory only the
 * server user can read; this page sees the prompt and your keystrokes, never
 * the token.
 *
 * Terminals are project-scoped on the wire, so a project id is needed even
 * though the login runs nowhere near a workspace. Any project you own will
 * do; it is the topic the output is published on and nothing more.
 *
 * The process lives while `active` is true. Bumping `generation` ends it and
 * starts a fresh one -- a new sign-in, with a new address.
 */
export function useLoginTerminal({
  program,
  projectId,
  credentialWorkspaceId,
  active,
  generation = 0,
  onData,
  onExited,
}: {
  program: LoginProgram
  projectId: string
  /** Sign in this workspace's dedicated subscription instead of your own. */
  credentialWorkspaceId?: string
  active: boolean
  generation?: number
  /** Every chunk of output, as it arrives, unbatched. */
  onData?: (data: string) => void
  /** The CLI has exited. */
  onExited?: () => void
}) {
  const [output, setOutput] = React.useState<TerminalOutput>(EMPTY_OUTPUT)
  const [status, setStatus] = React.useState<LoginTerminalStatus>("connecting")
  const [error, setError] = React.useState<string | null>(null)
  const clientRef = React.useRef<UcchClient | null>(null)
  const terminalRef = React.useRef<string | null>(null)
  const handlers = React.useRef({ onData, onExited })
  handlers.current = { onData, onExited }

  // The tab's one socket (lib/realtime.tsx).
  const { client: shared } = useRealtime()
  React.useEffect(() => {
    if (!active || !shared) return

    const client = shared
    clientRef.current = client
    const id = crypto.randomUUID()
    terminalRef.current = id
    let exited = false
    setOutput(EMPTY_OUTPUT)
    setStatus("connecting")
    setError(null)

    const batch = frameBatcher<string>((chunks) =>
      setOutput((current) => appendOutput(current, chunks, MAX_CHUNKS)),
    )
    // Straight from the socket: `client.events` is a capped history, and a
    // cursor into it stops moving once it is full.
    const offEvents = client.onEvent(({ event }) => {
      if (event.type !== "terminal.output" || event.terminalId !== id) return
      batch.push(event.data)
      handlers.current.onData?.(event.data)
      // The reactor prints this line itself when the process ends; there
      // is no other signal on the wire that a terminal has closed.
      if (!exited && /\[exited with /.test(event.data)) {
        exited = true
        setStatus("exited")
        handlers.current.onExited?.()
      }
    })

    // Set by the cleanup. The create below is async; a cleanup that runs
    // before it is sent (React's dev double-mount, a quick close) would
    // otherwise close nothing and leave the process that follows orphaned.
    let cancelled = false
    void (async () => {
      await client.whenReady()
      if (cancelled) return
      // Subscribed before the program starts, or its first prompt is lost.
      await client.subscribe({ name: "terminal", terminalId: id })
      if (cancelled) return
      await client.dispatch({
        type: "terminal.create",
        projectId,
        terminalId: id,
        cols: 100,
        rows: 28,
        program,
        ...(credentialWorkspaceId ? { credentialWorkspaceId } : {}),
      })
      if (cancelled) {
        // Cleaned up while the create was in flight: close it now it exists.
        void client.dispatch({ type: "terminal.close", terminalId: id }).catch(() => {})
        return
      }
      if (!exited) setStatus("running")
    })().catch((e) => {
      if (cancelled) return
      setStatus("error")
      setError(e instanceof Error ? e.message : String(e))
    })

    return () => {
      cancelled = true
      offEvents()
      batch.cancel()
      // Closing the dialog ends the flow: a half-finished login left running
      // on the server is a prompt nobody will ever answer.
      void client.dispatch({ type: "terminal.close", terminalId: id }).catch(() => {})
      client.unsubscribe({ name: "terminal", terminalId: id })
      clientRef.current = null
      terminalRef.current = null
    }
  }, [active, generation, program, projectId, credentialWorkspaceId, shared])

  const send = React.useCallback((data: string) => {
    const id = terminalRef.current
    if (!id) return
    clientRef.current?.terminalInput(id, data)
  }, [])
  const resize = React.useCallback((cols: number, rows: number) => {
    const id = terminalRef.current
    if (!id) return
    clientRef.current?.terminalResize(id, cols, rows)
  }, [])
  /** Ends the process now, without waiting for the dialog to close. */
  const kill = React.useCallback(() => {
    const id = terminalRef.current
    if (!id) return
    void clientRef.current?.dispatch({ type: "terminal.close", terminalId: id }).catch(() => {})
  }, [])

  return { output, status, error, send, resize, kill }
}

/**
 * A terminal in a dialog, running a provider's sign-in flow as it is.
 *
 * Codex's device-code flow needs nothing typed back, so the terminal is the
 * whole interface. Claude's paste-a-code flow has its own guided dialog
 * (`claude-login-dialog.tsx`) built on the same `useLoginTerminal`.
 */
export function LoginTerminalDialog({
  projectId,
  credentialWorkspaceId,
  open,
  onOpenChange,
  onExited,
}: {
  projectId: string
  credentialWorkspaceId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The CLI has exited: time to look at the provider card again. */
  onExited?: () => void
}) {
  const { output, status, error, send, resize } = useLoginTerminal({
    program: "codex-login",
    projectId,
    credentialWorkspaceId,
    active: open,
    onExited,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Sign in to Codex</DialogTitle>
          <DialogDescription>
            This runs <code className="font-mono">codex login --device-auth</code> on the server, in your own
            credential directory. Open the link it prints, enter the code, and approve.
          </DialogDescription>
        </DialogHeader>
        <div className="bg-background h-[24rem] overflow-hidden rounded-md border">
          {status === "connecting" && (
            <p className="text-muted-foreground p-4 text-sm">Connecting…</p>
          )}
          {status === "error" && (
            <p className="text-destructive p-4 text-sm">{error ?? "Could not start the sign-in."}</p>
          )}
          <XtermPane
            hidden={status === "connecting" || status === "error"}
            data={output}
            onInput={send}
            onResize={resize}
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {status === "exited"
            ? "The sign-in has finished. Close this to refresh the provider status."
            : "Closing this window ends the sign-in."}
        </p>
      </DialogContent>
    </Dialog>
  )
}
