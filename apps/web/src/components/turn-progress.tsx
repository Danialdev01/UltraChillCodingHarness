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
export function TurnProgress({ active }: { active: TurnActivity }) {
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
    <div
      className="text-muted-foreground flex items-center gap-2 px-1 text-xs"
      // Announced once rather than on every tick: a live region that reread
      // the clock each second would talk over everything else.
      role="status"
      aria-live="polite"
    >
      <Loader2Icon className="size-3 shrink-0 animate-spin" />
      <span className="text-foreground">
        {active.retry
          ? `Retrying (${active.retry.attempt}/${active.retry.maxRetries})…`
          : `${word}…`}
      </span>
      <span className="tabular-nums">
        (
        {elapsed !== null && <>{formatElapsed(elapsed)} · </>}
        <span title="Estimated from what has streamed back; exact usage is recorded when the turn ends">
          ↓ ~{formatTokens(tokens)} tokens
        </span>
        )
      </span>
      <span className="text-text-subtle ml-auto hidden sm:inline">esc to stop</span>
    </div>
  )
}
