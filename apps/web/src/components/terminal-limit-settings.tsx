"use client"

import * as React from "react"
import { MAX_TERMINALS_PER_PROJECT } from "@ucch/protocol/plain"
import { MinusIcon, PlusIcon, SquareTerminalIcon } from "lucide-react"

import { SettingsSection } from "@/components/layout/settings-section"
import { Skeleton } from "@/components/ui/skeleton"
import type { Workspace } from "@/lib/session"
import { fetchHarnessSettings, setAgentSettings } from "@/lib/workspace-api"

const MIN = 1
const MAX = MAX_TERMINALS_PER_PROJECT

/**
 * How many terminals may run at once in each of the workspace's projects.
 *
 * Kept on the server with the workspace's other settings, so it holds for
 * every member: a project's terminals are shared by its sessions, and this
 * is the bound on them. Everyone sees it; only those who manage the
 * workspace's settings can change it. The field commits on blur or Enter,
 * like the font sizes, so typing "12" does not pass through a limit of 1.
 */
export function TerminalLimitSettings({ workspace }: { workspace: Workspace }) {
  const manages = workspace.permissions.includes("credentials.manage")
  const [limit, setLimit] = React.useState<number | null>(null)
  const [draft, setDraft] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let live = true
    fetchHarnessSettings(workspace.id).then(
      (settings) => {
        if (!live) return
        setLimit(settings.agent.terminals.maxPerProject)
        setDraft(String(settings.agent.terminals.maxPerProject))
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
    }
  }, [workspace.id])

  async function choose(next: number) {
    if (limit === null) return
    const clamped = Math.min(MAX, Math.max(MIN, Math.round(next)))
    setDraft(String(clamped))
    if (clamped === limit) return
    setSaving(true)
    setError(null)
    try {
      const saved = await setAgentSettings(workspace.id, { terminals: { maxPerProject: clamped } })
      setLimit(saved.agent.terminals.maxPerProject)
      setDraft(String(saved.agent.terminals.maxPerProject))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setDraft(String(limit))
    } finally {
      setSaving(false)
    }
  }

  function commitDraft() {
    const parsed = Number(draft.trim())
    // Not a number: back to what is in force rather than leaving it there.
    if (draft.trim() === "" || !Number.isFinite(parsed)) setDraft(String(limit ?? ""))
    else void choose(parsed)
  }

  const disabled = !manages || limit === null || saving

  return (
    <SettingsSection
      icon={SquareTerminalIcon}
      title="Terminals per project"
      description={
        <>
          The most terminals that may be open at once in one project, counting every member&apos;s and every
          session&apos;s. Between {MIN} and {MAX}. The server may hold a project to a lower ceiling.
          {!manages && " Only workspace admins can change it."}
        </>
      }
      bare
    >
      {limit === null && !error ? (
        // The stepper's own shape until the setting arrives.
        <Skeleton className="mt-4 h-8 w-[7.5rem] rounded-lg" />
      ) : (
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="bg-muted/40 inline-flex items-center rounded-lg border p-0.5">
          <button
            type="button"
            aria-label="Fewer"
            disabled={disabled || limit <= MIN}
            onClick={() => limit !== null && void choose(limit - 1)}
            className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40"
          >
            <MinusIcon className="size-3.5" />
          </button>
          <input
            type="number"
            inputMode="numeric"
            aria-label="Terminals per project"
            min={MIN}
            max={MAX}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
            className="bg-background h-7 w-14 rounded-md text-center font-mono text-xs shadow-sm outline-hidden disabled:opacity-60 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            type="button"
            aria-label="More"
            disabled={disabled || limit >= MAX}
            onClick={() => limit !== null && void choose(limit + 1)}
            className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
        <span className="text-muted-foreground text-xs">active terminals</span>
      </div>
      )}
      {error && (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {error}
        </p>
      )}
    </SettingsSection>
  )
}
