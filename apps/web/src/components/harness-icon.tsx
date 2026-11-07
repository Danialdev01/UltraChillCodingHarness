import { getHarness } from "@/lib/harnesses"
import { cn } from "@/lib/utils"

/**
 * A session's harness, as its mark: the one component every place that
 * shows which agent runs a session uses -- sidebar card, hover card, the
 * harness picker, the session header. `harness` is a provider id
 * (`threads.provider`) or a harness id; anything unknown is a generic bot.
 *
 * `pulse` is a running session in the compact list, where a badge would
 * crowd the row: the mark breathes instead (and holds still under
 * reduced motion).
 */
export function HarnessIcon({
  harness,
  size = 16,
  pulse = false,
  title,
  className,
}: {
  harness: string | null | undefined
  size?: number
  pulse?: boolean
  /** The accessible name; the harness's name by default. */
  title?: string
  className?: string
}) {
  const def = getHarness(harness)
  const Icon = def.icon
  return (
    <Icon
      size={size}
      title={title ?? def.name}
      className={cn("shrink-0", def.id === "unknown" && "text-muted-foreground", pulse && "motion-safe:animate-pulse", className)}
    />
  )
}
