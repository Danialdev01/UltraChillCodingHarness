"use client"

import { FolderIcon, GitBranchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The top of the panel: which workspace this is, as a button that opens
 * the switcher, with a badge on the right while anything in it is running,
 * and a line of counts underneath.
 *
 * The badge sits in a slot of its own on the right, so the name does not
 * shift when the badge comes and goes.
 */
export function WorkspaceHeader({
  switcher,
  running,
  projectCount,
  sessionCount,
  sessionWorkspace,
}: {
  /** The switcher's trigger: the overline and the workspace's name. */
  switcher: React.ReactNode
  running: number
  projectCount: number
  sessionCount: number
  /** In a session workspace each session is its own project, so only sessions are counted. */
  sessionWorkspace: boolean
}) {
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">{switcher}</div>
        {running > 0 && <RunningBadge count={running} />}
      </div>
      <div className="text-muted-foreground mt-1.5 flex min-w-0 items-center gap-3 text-xs tabular-nums">
        {!sessionWorkspace && (
          <span className="flex min-w-0 items-center gap-1">
            <FolderIcon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{plural(projectCount, "project")}</span>
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1">
          <GitBranchIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{plural(sessionCount, "session")}</span>
        </span>
      </div>
    </div>
  )
}

/**
 * "{n} running". In light mode it is a solid pill, because it sits over the
 * sun and a tint would vanish into it. In dark mode it is a soft tint.
 */
export function RunningBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "bg-success-soft text-success mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium tabular-nums",
        "light:bg-success light:text-primary-foreground light:shadow-sm light:ring-1 light:ring-foreground/5",
        className,
      )}
      role="status"
    >
      <span className="relative flex size-1.5" aria-hidden>
        <span className="absolute inset-0 rounded-full bg-current motion-safe:animate-ping" />
        <span className="relative size-1.5 rounded-full bg-current" />
      </span>
      {count} running
    </span>
  )
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`
}
