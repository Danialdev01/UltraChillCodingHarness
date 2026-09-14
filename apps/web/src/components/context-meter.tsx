"use client"

import * as React from "react"
import { EraserIcon, Loader2Icon } from "lucide-react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  contextPercent,
  contextUsage,
  formatContextTokens,
} from "@/lib/context-window"

/**
 * How full this conversation's context window is, and a way to empty it.
 *
 * The number is measured rather than guessed -- the last completed turn's
 * prompt plus its reply, as the provider counted them -- so it lags by one
 * turn and is right rather than live and approximate. The tooltip says so;
 * a meter that quietly showed an estimate would be worse than one that
 * admits when it last looked.
 */
export function ContextMeter({
  tokens,
  limit,
  onClear,
  clearing,
  disabled,
}: {
  tokens: number | null
  limit: number | null
  onClear: () => void
  clearing: boolean
  /** No turn may start, so there is nothing to clear either. */
  disabled: boolean
}) {
  const usage = contextUsage(tokens, limit)

  // Clearing loses the visible conversation, so the button asks once. A
  // second click within a few seconds does it; anything else puts it back.
  // Cheaper than a dialog for something that destroys nothing on the server.
  const [armed, setArmed] = React.useState(false)
  React.useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])

  const fill =
    usage.tone === "full"
      ? "bg-destructive"
      : usage.tone === "warn"
        ? "bg-amber-500"
        : "bg-ucch-active"

  return (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            // A div, not a button: there is nothing to press here, and a
            // button would take a tab stop for a readout.
            <div className="flex cursor-default items-center gap-1.5" />
          }
        >
          <div className="bg-muted h-1.5 w-10 overflow-hidden rounded-full @md:w-16">
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
              style={{ width: `${(usage.ratio ?? 0) * 100}%` }}
            />
          </div>
          <span className="text-muted-foreground font-mono text-[10px] tabular-nums">
            {usage.ratio === null ? usage.label : `${contextPercent(usage.ratio)}%`}
          </span>
        </TooltipTrigger>

        <TooltipContent>
          <p className="font-medium">Context window</p>
          <p className="text-xs">
            {usage.tokens === null
              ? "Nothing measured yet — the first reply will fill this in."
              : usage.limit === null
                ? `${formatContextTokens(usage.tokens)} tokens in this conversation. This model publishes no window size.`
                : `${usage.label} tokens used.`}
          </p>
          {usage.tokens !== null && (
            <p className="text-xs opacity-70">
              Counted at the last completed turn, so it lags the newest message.
            </p>
          )}
        </TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => {
                if (armed) {
                  setArmed(false)
                  onClear()
                } else {
                  setArmed(true)
                }
              }}
              disabled={disabled || clearing}
              className={`flex h-7 items-center gap-1 rounded-md px-1.5 text-xs disabled:opacity-50 ${
                armed
                  ? "text-destructive bg-destructive/10"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            />
          }
        >
          {clearing ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <EraserIcon className="size-3.5" />
          )}
          {armed && <span>Clear?</span>}
          <span className="sr-only">Clear the context window</span>
        </TooltipTrigger>

        <TooltipContent>
          <p className="font-medium">Clear the context window</p>
          <p className="text-xs">
            Starts a fresh conversation, so the next message goes to the model with no history.
            The current one is kept in the project&apos;s log, but leaves this view.
          </p>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
