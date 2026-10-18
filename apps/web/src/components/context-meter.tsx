"use client"

import * as React from "react"
import { EraserIcon, Loader2Icon } from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { contextPercent, contextUsage, formatContextTokens } from "@/lib/context-window"

/**
 * How full this conversation's context window is, and a way to empty it.
 *
 * The number is measured rather than guessed -- the last completed turn's
 * prompt plus its reply, as the provider counted them -- so it lags by one
 * turn and is right rather than live and approximate. The tooltip says so;
 * a meter that quietly showed an estimate would be worse than one that
 * admits when it last looked.
 *
 * In a narrow panel the bar and the eraser fold into one ring: the share
 * used, drawn round a circle with the percentage inside, and pressing it
 * asks whether to clear. A phone has no hover for the tooltip, and no room
 * for two controls where one will do.
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
        ? "bg-warning"
        : "bg-ucch-active"
  const stroke =
    usage.tone === "full"
      ? "text-destructive"
      : usage.tone === "warn"
        ? "text-warning"
        : "text-ucch-active"

  const [confirming, setConfirming] = React.useState(false)
  const percent = usage.ratio === null ? null : contextPercent(usage.ratio)

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={disabled || clearing}
        title={
          usage.ratio === null
            ? `Context: ${usage.label}. Press to clear.`
            : `Context ${percent}% full (${usage.label} tokens). Press to clear.`
        }
        className="hover:bg-muted relative flex size-7 shrink-0 items-center justify-center rounded-full disabled:opacity-50 @md:hidden"
      >
        {clearing ? (
          <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
        ) : (
          <>
            <svg viewBox="0 0 24 24" className="size-6 -rotate-90" aria-hidden>
              <circle
                cx="12"
                cy="12"
                r="10"
                fill="none"
                strokeWidth="2.5"
                className="stroke-muted"
              />
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
        <span className="sr-only">Clear the context window</span>
      </button>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Do you want to clear your context?"
        description="The next message starts a fresh conversation with no history. The current one is kept in the project's log."
        confirmLabel="Yes"
        onConfirm={async () => onClear()}
      />

      <div className="hidden items-center gap-1.5 @md:flex">
        <Tooltip>
          <TooltipTrigger
            render={
              // A div, not a button: there is nothing to press here, and a
              // button would take a tab stop for a readout.
              <div className="flex cursor-default items-center gap-1.5" />
            }
          >
            <div className="bg-muted h-1.5 w-6 overflow-hidden rounded-full @md:w-16">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${fill}`}
                style={{ width: `${(usage.ratio ?? 0) * 100}%` }}
              />
            </div>
            <span className="text-muted-foreground hidden font-mono text-[10px] tabular-nums @md:inline">
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
              <p className="text-xs">
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
                    ? "text-destructive bg-danger-soft"
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
            {armed && <span>Clear</span>}
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
    </>
  )
}
