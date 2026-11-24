"use client"

import * as React from "react"
import { ClockIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ScheduledResume } from "@ucch/protocol"
import { formatResume, fromLocalInput, toLocalInput } from "@/lib/resume-time"

/** A time to carry on at, with the button that sets it. */
export function ResumeTimeField({
  initial,
  busy,
  label,
  onSubmit,
}: {
  initial: number
  busy: boolean
  label: string
  onSubmit: (at: string) => void
}) {
  const [value, setValue] = React.useState(() => toLocalInput(initial))
  const at = fromLocalInput(value)
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        if (at) onSubmit(at)
      }}
    >
      <Input
        type="datetime-local"
        aria-label="Continue at"
        className="h-7 w-auto text-xs md:text-xs"
        value={value}
        min={toLocalInput(Date.now())}
        disabled={busy}
        onChange={(e) => setValue(e.target.value)}
      />
      <Button type="submit" size="sm" className="h-7 text-xs" disabled={busy || !at}>
        {busy && <Loader2Icon className="animate-spin" />}
        {label}
      </Button>
    </form>
  )
}

/** A session waiting to carry on after a usage limit: when, and the ways to change that. */
export function ResumeCard({
  resume,
  harness,
  onUpdate,
}: {
  resume: ScheduledResume
  harness: string
  /** A new time, or null to cancel. */
  onUpdate: (resumeId: string, at: string | null) => Promise<void>
}) {
  const [busy, setBusy] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const update = async (at: string | null) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onUpdate(resume.resumeId, at)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="status"
      data-testid="resume-card"
      className="border-border bg-muted/40 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <ClockIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">
          Continues on {harness} at <span className="font-medium">{formatResume(resume.at)}</span>
        </span>
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => void update(new Date().toISOString())}>
            Continue now
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={() => setEditing((open) => !open)}>
            Change time
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => void update(null)}>
            Cancel
          </Button>
        </div>
      </div>
      {editing && <ResumeTimeField initial={Date.parse(resume.at)} busy={busy} label="Set time" onSubmit={(at) => void update(at)} />}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  )
}
