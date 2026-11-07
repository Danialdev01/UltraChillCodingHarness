import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The bar across the top of a full-bleed page -- tasks, timeline, activity,
 * documentation, a database view: what the page is, how many it holds, and
 * its actions on the right. One height (h-10) on every page, so moving
 * between them never shifts the content.
 */
export function PageToolbar({
  icon: Icon,
  title,
  count,
  tabs,
  children,
  actions,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>
  title?: React.ReactNode
  count?: number
  /** A view switch right after the title: tabs or a segmented control. */
  tabs?: React.ReactNode
  /** Controls in the middle: filters, a segmented view switch. */
  children?: React.ReactNode
  /** Controls pinned to the right: the primary action last. */
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="page-toolbar"
      className={cn("flex h-10 shrink-0 items-center gap-2 border-b px-3 sm:px-4", className)}
    >
      {(Icon || title) && (
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {Icon && <Icon className="text-muted-foreground size-4 shrink-0" />}
          {title && <h1 className="truncate text-sm font-medium">{title}</h1>}
          {count !== undefined && (
            <span className="text-muted-foreground text-xs tabular-nums">{count}</span>
          )}
        </div>
      )}
      {tabs && <div className="flex min-w-0 shrink items-center">{tabs}</div>}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  )
}
