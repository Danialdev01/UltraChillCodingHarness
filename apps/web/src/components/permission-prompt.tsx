"use client"

import * as React from "react"
import { CheckCheckIcon, CheckIcon, Loader2Icon, ShieldAlertIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { summariseInput, type PermissionPrompt } from "@/lib/chat-messages"

/**
 * The agent's permission question, above the composer -- the native loop's
 * and Claude Code's alike.
 *
 * The turn is blocked on it: the CLI has paused a tool call its permission
 * mode does not cover and will not move until someone answers, so this is
 * the one thing on the page that needs attention. It sits where the
 * progress line sits, for the same reason -- it is about the turn, not the
 * draft -- and goes when the answer is recorded, from this tab or another.
 *
 * Allow runs the call exactly as shown; the arguments are echoed back to
 * the CLI unchanged. Allow All does the same and stops asking on this chat
 * until the server restarts. Deny hands the model the reason typed here, or
 * a plain refusal, as the tool's error so it can take another route.
 */
export function PermissionPromptCard({
  prompt,
  onReply,
}: {
  prompt: PermissionPrompt
  onReply: (
    requestId: string,
    behavior: "allow" | "deny",
    message?: string,
    scope?: "once" | "session",
  ) => Promise<void>
}) {
  const [busy, setBusy] = React.useState<"allow" | "allow_all" | "deny" | null>(null)
  const [reason, setReason] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const summary = summariseInput(prompt.input)
  const detail = formatInput(prompt.input)

  const reply = async (choice: "allow" | "allow_all" | "deny") => {
    if (busy) return
    setBusy(choice)
    setError(null)
    try {
      if (choice === "allow_all") await onReply(prompt.requestId, "allow", undefined, "session")
      else await onReply(prompt.requestId, choice, choice === "deny" ? reason.trim() || undefined : undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
    // On success the prompt leaves the state and this unmounts; resetting
    // `busy` here would flash the buttons back for a frame first.
  }

  return (
    <div
      role="alertdialog"
      aria-label={`${prompt.toolName} needs your approval`}
      className="border-ucch-active/50 bg-ucch-active/5 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs"
    >
      <div className="flex items-center gap-2">
        <ShieldAlertIcon className="text-ucch-active size-3.5 shrink-0" />
        <span className="font-medium">
          The agent wants to run <span className="font-mono">{prompt.toolName}</span>
        </span>
        {prompt.description && (
          <span className="text-muted-foreground truncate">— {prompt.description}</span>
        )}
      </div>

      {/* The command itself, in full: a person approving `rm -rf` should
          see the whole line, not the first 80 characters of it. */}
      <pre className="bg-muted/50 max-h-40 overflow-auto rounded p-2 font-mono whitespace-pre-wrap">
        {detail || summary || "(no arguments)"}
      </pre>

      <div className="flex flex-col gap-2 @md:flex-row @md:items-center">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && reason.trim()) {
              e.preventDefault()
              void reply("deny")
            }
          }}
          placeholder="Tell the agent what to do instead (optional, sent on Deny)"
          aria-label="Reason for denying"
          className="bg-background placeholder:text-muted-foreground min-w-0 flex-1 rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-1"
          disabled={busy !== null}
        />
        <div className="flex shrink-0 gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={() => void reply("deny")}
            disabled={busy !== null}
          >
            {busy === "deny" ? <Loader2Icon className="animate-spin" /> : <XIcon />}
            Deny
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={() => void reply("allow_all")}
            disabled={busy !== null}
            title="Allow this and everything else the agent asks in this chat, until the server restarts"
          >
            {busy === "allow_all" ? <Loader2Icon className="animate-spin" /> : <CheckCheckIcon />}
            Allow All
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => void reply("allow")}
            disabled={busy !== null}
            autoFocus
          >
            {busy === "allow" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
            Allow
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * What a reader needs to judge the call. A shell command is the command
 * line; anything else is its arguments, pretty-printed.
 */
function formatInput(input: unknown): string {
  if (typeof input === "string") return input
  if (typeof input !== "object" || input === null) return ""
  const record = input as Record<string, unknown>
  if (typeof record.command === "string") return record.command
  try {
    return JSON.stringify(input, null, 2) ?? ""
  } catch {
    return String(input)
  }
}
