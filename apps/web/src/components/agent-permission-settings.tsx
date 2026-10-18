"use client"

import * as React from "react"
import { CheckIcon, Loader2Icon, ShieldCheckIcon } from "lucide-react"
import type { AgentPermissionMode } from "@ucch/protocol"

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

const CHOICES: { id: AgentPermissionMode; label: string; hint: string }[] = [
  {
    id: "strict",
    label: "Strict",
    hint: "Asks before every command and every file edit. Reading and searching never ask.",
  },
  {
    id: "normal",
    label: "Normal",
    hint:
      "Edits and everyday commands (installs, builds, tests, git commit) run on their own. Asks before " +
      "risky ones: deleting files, sudo, git push or reset, dropping a database, piping a download into a shell, " +
      "or writing outside the project.",
  },
  {
    id: "allow_all",
    label: "Allow All",
    hint: "Never asks. The agent runs every command and edit by itself, so only use this on projects you can restore.",
  },
]

/**
 * How much the agent may do before it asks.
 *
 * Applies to the native agent and Claude Code; Codex runs non-interactively
 * inside its workspace sandbox and has no way to ask. A chat can still be
 * switched to Allow All for its session from the prompt's own button.
 */
export function AgentPermissionSettings() {
  const [mode, setMode] = React.useState<AgentPermissionMode | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch("/api/settings", { credentials: "include" })
      if (!response.ok || cancelled) return
      const body = (await response.json()) as { agentPermissionMode?: AgentPermissionMode }
      setMode(body.agentPermissionMode ?? "normal")
    })().catch(() => setError("Could not load settings."))
    return () => {
      cancelled = true
    }
  }, [])

  async function choose(next: AgentPermissionMode) {
    if (busy || next === mode) return
    const previous = mode
    setMode(next)
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch("/api/settings/agent-permission-mode", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      })
      const body = (await response.json()) as { agentPermissionMode?: AgentPermissionMode; error?: string }
      if (!response.ok) throw new Error(body.error ?? `save failed: ${response.status}`)
      setSaved(true)
    } catch (e) {
      setMode(previous)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const current = CHOICES.find((c) => c.id === mode)

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheckIcon className="text-muted-foreground size-4" />
        Agent permission
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        What the agent may do before it stops and asks you in the chat. Applies to the built-in
        agent and Claude Code, from the next action on. Codex runs in its workspace sandbox and
        does not ask.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Agent permission"
          className="bg-muted/40 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
        >
          {CHOICES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              disabled={mode === null || busy}
              onClick={() => void choose(id)}
              className={cn(
                "h-7 rounded-md px-3 text-xs transition-colors disabled:cursor-default",
                mode === id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {busy && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
        {saved && !busy && <CheckIcon className="text-ucch-active size-4" aria-label="Saved" />}
      </div>

      {error ? (
        <p className="text-destructive mt-3 text-sm">{error}</p>
      ) : current ? (
        <p className="text-muted-foreground mt-3 max-w-prose text-sm">{current.hint}</p>
      ) : (
        <div className="mt-3 flex max-w-prose flex-col gap-2 py-0.5">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      )}
    </section>
  )
}
