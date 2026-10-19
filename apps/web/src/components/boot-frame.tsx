import { LogoMark } from "@/components/logo-mark"

/**
 * What the boot screen looks like, apart from what it does: the sign-in page
 * draws this while the boot screen's own code is still arriving, so the
 * moment after "Sign in" looks the same either way.
 */
export function BootFrame({ progress }: { progress: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-background fixed inset-0 z-50 flex flex-col items-center justify-center gap-6"
    >
      <LogoMark className="text-foreground size-12" />
      <div className="bg-muted h-1 w-48 overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <p className="text-muted-foreground text-sm">Opening your workspace…</p>
    </div>
  )
}
