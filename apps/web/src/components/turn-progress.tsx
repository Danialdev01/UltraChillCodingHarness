"use client"

import * as React from "react"
import { Loader2Icon } from "lucide-react"

import { estimateTokens, type TurnActivity } from "@/lib/chat-messages"
import {
  formatElapsed,
  formatTokens,
  WORD_INTERVAL_MS,
  workingWord,
} from "@/lib/turn-status"
import { useLineage } from "@/lib/subagent-lineage"

/**
 * "Percolating… (3m 43s · ↓ 16.9k tokens)", above the composer.
 *
 * A turn can run for minutes with nothing on screen between tool rows, and
 * this is what distinguishes working from hung. Two ticking numbers rather
 * than a bare spinner, because they are what a person actually wants to know
 * while waiting: how long, and is it still producing anything.
 *
 * The count is an estimate and says so. Real usage arrives once, on
 * `agent.turn_completed`, so anything shown during a turn is counted from
 * what has streamed back -- prose, thinking, and tool arguments -- at four
 * characters to the token.
 */
export function TurnProgress({
  active,
  onStop,
  stopping,
}: {
  active: TurnActivity
  /** Stops the turn: offered on the strip itself, beside what it stops. */
  onStop?: () => void
  stopping?: boolean
}) {
  const lineage = useLineage()
  const out = lineage.filter((entry) => entry.run.status === "running")
  // One interval for both, at a second: the clock needs it, and the word
  // changing on its own schedule inside the same tick avoids a second timer
  // for something nobody is watching that closely.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const elapsed = active.startedAt === null ? null : now - active.startedAt
  const word = workingWord(active.turnId, Math.floor((elapsed ?? 0) / WORD_INTERVAL_MS))
  const tokens = estimateTokens(active.chars)

  return (
    // Attached to the top of the composer, as a tab on its box: it is about
    // the turn the composer is waiting on, and it comes and goes without
    // moving the box itself.
    <div
      className="text-muted-foreground bg-card/70 mx-3 -mb-2 flex min-w-0 items-center gap-2 rounded-t-xl border border-b-0 px-3 py-1.5 text-xs backdrop-blur"
      role="status"
      aria-live="polite"
      data-testid="turn-progress"
    >
      {out.length > 0 ? (
        <>
          <span className="bg-ucch-active size-1.5 shrink-0 animate-pulse rounded-full" aria-hidden />
          <span className="text-foreground shrink-0 font-medium">
            Waiting on {out.length} {out.length === 1 ? "subagent" : "subagents"}
          </span>
          <span className="truncate">
            {out.map((entry) => entry.run.description ?? entry.run.agent).join(", ")}
          </span>
        </>
      ) : (
        <>
          <Loader2Icon className="size-3 shrink-0 animate-spin" />
          <span className="text-foreground shrink-0">
            {active.retry
              ? `Retrying (${active.retry.attempt}/${active.retry.maxRetries})…`
              : `${word}…`}
          </span>
          <span className="truncate tabular-nums">
            (
            {elapsed !== null && <>{formatElapsed(elapsed)} · </>}
            <span title="Estimated from what has streamed back; exact usage is recorded when the turn ends">
              ↓ ~{formatTokens(tokens)} tokens
            </span>
            )
          </span>
        </>
      )}
      {onStop ? (
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          title="Stop the agent (esc)"
          className="text-foreground hover:bg-muted ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-medium disabled:opacity-50"
        >
          Stop
        </button>
      ) : (
        <span className="text-text-subtle ml-auto hidden shrink-0 sm:inline">esc to stop</span>
      )}
    </div>
  )
}
