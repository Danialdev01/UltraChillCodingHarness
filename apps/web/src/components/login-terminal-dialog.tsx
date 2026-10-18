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
import { UcchClient } from "@/lib/client"
import { EMPTY_OUTPUT, appendOutput, frameBatcher, type TerminalOutput } from "@/lib/terminal-output"

export type LoginProgram = "claude-login" | "codex-login"

/** Chunks kept per session; the pane's own scrollback is the real buffer. */
const MAX_CHUNKS = 2_000

const TITLES: Record<LoginProgram, { title: string; description: string }> = {
  "claude-login": {
    title: "Sign in to Claude Code",
    description:
      "This runs `claude auth login` on the server, in your own credential directory. Open the link it prints in your browser, approve, and paste the code back here.",
  },
  "codex-login": {
    title: "Sign in to Codex",
    description:
      "This runs `codex login --device-auth` on the server, in your own credential directory. Open the link it prints, enter the code, and approve.",
  },
}

/**
 * A terminal in a dialog, running one provider's sign-in flow.
 *
 * The server cannot open your browser and your browser cannot reach a
 * callback on the server, so the CLIs fall back to the code-paste flow they
 * ship for exactly this case -- and a terminal is the honest way to show it.
 * The credential lands in a directory only the server user can read; this
 * page sees the prompt and your keystrokes, never the token.
 *
 * Terminals are project-scoped on the wire, so a project id is needed even
 * though the login runs nowhere near a workspace. Any project you own will
 * do; it is the topic the output is published on and nothing more.
 */
export function LoginTerminalDialog({
  program,
  projectId,
  credentialWorkspaceId,
  open,
  onOpenChange,
  onExited,
}: {
  program: LoginProgram
  projectId: string
  /** Sign in this workspace's dedicated subscription instead of your own. */
  credentialWorkspaceId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The CLI has exited: time to look at the provider card again. */
  onExited?: () => void
}) {
  const [output, setOutput] = React.useState<TerminalOutput>(EMPTY_OUTPUT)
  const [status, setStatus] = React.useState<"connecting" | "running" | "exited" | "error">(
    "connecting",
  )
  const [error, setError] = React.useState<string | null>(null)
  const clientRef = React.useRef<UcchClient | null>(null)
  const terminalRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (!open) return

    const client = new UcchClient()
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
      // The reactor prints this line itself when the process ends; there
      // is no other signal on the wire that a terminal has closed.
      if (!exited && /\[exited with /.test(event.data)) {
        exited = true
        setStatus("exited")
        onExited?.()
      }
    })
    const unsubscribe = () => {
      offEvents()
      batch.cancel()
    }

    void (async () => {
      await client.connect()
      await client.whenReady()
      // Subscribed before the program starts, or its first prompt is lost.
      await client.subscribe({ name: "terminal", terminalId: id })
      await client.dispatch({
        type: "terminal.create",
        projectId,
        terminalId: id,
        cols: 100,
        rows: 28,
        program,
        ...(credentialWorkspaceId ? { credentialWorkspaceId } : {}),
      })
      setStatus("running")
    })().catch((e) => {
      setStatus("error")
      setError(e instanceof Error ? e.message : String(e))
    })

    return () => {
      unsubscribe()
      // Closing the dialog ends the flow: a half-finished login left running
      // on the server is a prompt nobody will ever answer.
      void client.dispatch({ type: "terminal.close", terminalId: id }).catch(() => {})
      client.close()
      clientRef.current = null
      terminalRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, program, projectId, credentialWorkspaceId])

  const send = (data: string) => {
    const id = terminalRef.current
    if (!id) return
    void clientRef.current?.dispatch({ type: "terminal.input", terminalId: id, data }).catch(() => {})
  }
  const resize = (cols: number, rows: number) => {
    const id = terminalRef.current
    if (!id) return
    void clientRef.current
      ?.dispatch({ type: "terminal.resize", terminalId: id, cols, rows })
      .catch(() => {})
  }

  const copy = TITLES[program]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
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
