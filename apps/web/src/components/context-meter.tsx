"use client"

import * as React from "react"
import { HandIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  contextPercent,
  contextUsage,
  formatContextTokens,
  HANDOVER_RATIO,
} from "@/lib/context-window"

/**
 * How full this conversation's context window is, and a way to hand it over.
 *
 * One ring at every width: the share used, drawn round a circle with the
 * percentage inside. Pressing it opens the reading and a hand -- a handover,
 * which replaces the history with a brief of the work so far, on the same
 * harness, and then waits: the next message sent starts from that brief. There is
 * no clearing: a handover keeps the work and drops the bloat. Nobody has to
 * press it for long work: every harness compacts itself mid-turn at the
 * handover line and keeps going, quietly, as the Claude Code CLI does.
 *
 * The number is the provider's own reading where it sends one (OMP, Claude
 * Code: after each model call, so the ring moves while the turn runs) and
 * otherwise the last completed turn's usage, which lags by one turn.
 */
export function ContextMeter({
  tokens,
  limit,
  threshold = null,
  live = false,
  onHandover,
  handingOver,
  disabled,
  disabledReason,
  variant = "ring",
  className,
}: {
  tokens: number | null
  limit: number | null
  /** Where the session hands over or compacts, in tokens, or null when unknown. */
  threshold?: number | null
  /** The provider measured it after its last model call, not a turn's usage. */
  live?: boolean
  onHandover: () => void
  /** A handover is being written. */
  handingOver: boolean
  /** No handover may start now. */
  disabled: boolean
  /** Why, for the popover. */
  disabledReason?: string | null
  /**
   * A ring for the composer, or a labelled bar with "used / max" for the
   * session card beside the chat. Both open the same popover.
   */
  variant?: "ring" | "bar"
  className?: string
}) {
  const handoverAt = threshold ?? (limit ? Math.floor(limit * HANDOVER_RATIO) : null)
  const usage = contextUsage(tokens, limit, handoverAt)
  const [open, setOpen] = React.useState(false)

  const stroke =
    usage.tone === "full"
      ? "text-destructive"
      : usage.tone === "warn"
        ? "text-warning"
        : "text-ucch-active"
  const percent = usage.ratio === null ? null : contextPercent(usage.ratio)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {variant === "bar" ? (
        <PopoverTrigger
          render={
            <button
              type="button"
              title={
                usage.ratio === null
                  ? `Context: ${usage.label}`
                  : `Context ${percent}% full (${usage.label} tokens)`
              }
              className={`hover:bg-muted focus-visible:ring-ring flex w-full min-w-0 flex-col gap-1.5 rounded-md px-1.5 py-1.5 text-left outline-none focus-visible:ring-2 ${className ?? ""}`}
            />
          }
        >
          <span className="flex w-full items-center gap-2">
            <span className="text-muted-foreground text-2xs">Context window</span>
            {handingOver && <Loader2Icon className="text-muted-foreground size-3 animate-spin" />}
            <span
              className={`ml-auto font-mono text-2xs tabular-nums ${
                usage.tone === "full" ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {usage.tokens === null ? "0" : formatContextTokens(usage.tokens)}/
              {usage.limit === null ? "?" : formatContextTokens(usage.limit)}
            </span>
          </span>
          <span className="bg-muted relative block h-1.5 w-full overflow-hidden rounded-full">
            <span
              className={`absolute inset-y-0 left-0 rounded-full bg-current transition-[width] duration-500 ${stroke}`}
              style={{ width: `${Math.min(100, percent ?? 0)}%` }}
            />
            {usage.thresholdRatio !== null && (
              <span
                aria-hidden
                className="bg-foreground/40 absolute inset-y-0 w-px"
                style={{ left: `${usage.thresholdRatio * 100}%` }}
              />
            )}
          </span>
        </PopoverTrigger>
      ) : (
        <PopoverTrigger
          render={
            <button
              type="button"
              title={
                usage.ratio === null
                  ? `Context: ${usage.label}`
                  : `Context ${percent}% full (${usage.label} tokens)`
              }
              className={`hover:bg-muted relative flex size-7 shrink-0 items-center justify-center rounded-full ${className ?? ""}`}
            />
          }
        >
          {handingOver ? (
            <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
          ) : (
            <>
              <svg viewBox="0 0 24 24" className="size-6 -rotate-90" aria-hidden>
                <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2.5" className="stroke-muted" />
                {/* Nothing drawn at zero: a round cap on an empty arc is a stray dot. */}
                {(percent ?? 0) > 0 && (
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    fill="none"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    pathLength={100}
                    strokeDasharray={`${percent ?? 0} 100`}
                    className={`stroke-current transition-[stroke-dasharray] duration-500 ${stroke}`}
                  />
                )}
              </svg>
              <span
                className={`absolute font-mono text-[8px] leading-none tabular-nums ${
                  usage.tone === "full" ? "text-destructive" : "text-muted-foreground"
                }`}
              >
                {percent ?? "–"}
              </span>
            </>
          )}
          <span className="sr-only">Context window</span>
        </PopoverTrigger>
      )}

      <PopoverContent align="end" side={variant === "bar" ? "left" : "top"} className="w-72 p-3">
        <p className="text-sm font-medium">Context window</p>
        <p className="text-muted-foreground mt-1 text-xs">
          {usage.tokens === null
            ? "Nothing measured yet — the first reply will fill this in."
            : usage.limit === null
              ? `${formatContextTokens(usage.tokens)} tokens in this conversation. This model publishes no window size.`
              : `${usage.label} tokens used (${percent}%).`}
        </p>
        {handoverAt !== null && usage.limit !== null && (
          <p className="text-muted-foreground text-xs">
            Hands over by itself at {formatContextTokens(handoverAt)} tokens (
            {Math.round((handoverAt / usage.limit) * 100)}%).
          </p>
        )}
        {usage.tokens !== null && (
          <p className="text-muted-foreground text-xs">
            {live
              ? "Measured by the session after the model's last call."
              : "Counted at the last completed turn, so it lags the newest message."}
          </p>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3 w-full justify-start gap-2"
          disabled={disabled || handingOver}
          onClick={() => {
            setOpen(false)
            onHandover()
          }}
        >
          {handingOver ? <Loader2Icon className="size-4 animate-spin" /> : <HandIcon className="size-4" />}
          Hand over
        </Button>
        <p className="text-muted-foreground mt-1.5 text-xs">
          {disabled && disabledReason
            ? disabledReason
            : "Replaces the history with a brief of the work so far on the same harness. Nothing is sent: your next message starts from the brief. The transcript stays on screen."}
        </p>
      </PopoverContent>
    </Popover>
  )
}
