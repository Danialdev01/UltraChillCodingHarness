"use client"

import * as React from "react"
import { ListChecksIcon, Loader2Icon, PlayIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Plan mode's last step, above the composer: the agent's answer ended with
 * a plan (`<proposed_plan>`), and running it is the person's call. "Run the
 * plan" ends plan mode and sends the go-ahead, and the agent carries every
 * step out by itself; "Keep planning" leaves plan mode on, for another
 * round of changes typed in the composer.
 */
export function PlanReadyCard({
  onRun,
  onRefine,
}: {
  onRun: () => Promise<void>
  onRefine: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onRun()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  return (
    <div
      role="alertdialog"
      aria-label="The plan is ready"
      data-testid="plan-ready"
      className="border-ucch-active/50 bg-ucch-active/5 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs"
    >
      <div className="flex items-start gap-2">
        <ListChecksIcon className="text-ucch-active mt-0.5 size-3.5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">The plan is ready. Continue with it?</span>
          <span className="text-muted-foreground">
            The agent carries out every step by itself, then verifies the result. Or keep planning and say what to change.
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button type="button" size="sm" className="h-7 gap-1.5 text-xs" disabled={busy} onClick={() => void run()}>
          {busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlayIcon className="size-3.5" />}
          Run the plan
        </Button>
        <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={onRefine}>
          Keep planning
        </Button>
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  )
}
