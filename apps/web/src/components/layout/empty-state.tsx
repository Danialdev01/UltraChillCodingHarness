import * as React from "react"
import { SparklesIcon } from "lucide-react"

import { SoonBadge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * What a list, a pane or a page shows when it has nothing in it: an icon,
 * what is missing, what to do about it, and the button that does it.
 * The same everywhere, so "empty" never looks like "broken".
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  framed,
  badge,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  className?: string
  /** Inside a page rather than filling a pane: draw the dashed frame. */
  framed?: boolean
  badge?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center",
        framed && "rounded-lg border border-dashed",
        className,
      )}
    >
      {Icon && <Icon className="text-muted-foreground mb-1 size-8" aria-hidden />}
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium">{title}</p>
        {badge}
      </div>
      {description && <p className="text-muted-foreground max-w-sm text-sm">{description}</p>}
      {action && <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  )
}

/** The page or pane of a feature that has not been built yet. */
export function ComingSoon({
  icon,
  title,
  description,
  className,
  framed = true,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title: React.ReactNode
  description?: React.ReactNode
  className?: string
  framed?: boolean
}) {
  return (
    <EmptyState
      icon={icon ?? SparklesIcon}
      title={title}
      description={description}
      badge={<SoonBadge />}
      framed={framed}
      className={className}
    />
  )
}
