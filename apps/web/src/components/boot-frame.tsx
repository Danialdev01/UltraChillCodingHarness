import { LogoMark } from "@/components/logo-mark"
import { cn } from "@/lib/utils"

/**
 * What the boot screen looks like, apart from what it does: the logo in a
 * turning ring, a bar for how much of the app has loaded, and a line saying
 * what is loading now. The sign-in page draws it while the boot screen's own
 * code is still arriving, and the app layout draws it over a signed-in first
 * load (`BootGate`), so every way into the app opens the same way.
 *
 * The ring is the one spinner outside an action in flight: the boot screen is
 * a wait the person was told about, not a page change, and it lasts seconds.
 * Under reduced motion it holds still and the bar alone moves.
 */
export function BootFrame({
  progress,
  label = "Opening your workspace",
  leaving = false,
}: {
  progress: number
  label?: string
  /** Fading out: the app is opening underneath. */
  leaving?: boolean
}) {
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!leaving}
      className={cn(
        "bg-background fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 transition-opacity duration-300 ease-out",
        leaving && "pointer-events-none opacity-0",
      )}
    >
      <div className="relative flex size-20 items-center justify-center">
        <svg viewBox="0 0 80 80" className="absolute inset-0 size-full" aria-hidden>
          <circle cx="40" cy="40" r="37" fill="none" strokeWidth="2" className="stroke-muted" />
          <circle
            cx="40"
            cy="40"
            r="37"
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            // A quarter of the ring, turning.
            strokeDasharray="58 175"
            className="stroke-primary origin-center animate-spin [animation-duration:1.1s] motion-reduce:animate-none"
          />
        </svg>
        <LogoMark className="text-foreground size-9" />
      </div>
      <div className="flex w-56 flex-col items-center gap-3">
        <div
          className="bg-muted h-1 w-full overflow-hidden rounded-full"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label="Opening the app"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="text-muted-foreground flex w-full items-baseline justify-between gap-3 text-xs">
          <span className="truncate">{label}</span>
          <span className="tabular-nums">{percent}%</span>
        </div>
      </div>
    </div>
  )
}
