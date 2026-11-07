import * as React from "react"

import { cn } from "@/lib/utils"

const WIDTHS = {
  full: "",
  prose: "max-w-3xl",
  wide: "max-w-5xl",
} as const

/**
 * The padded frame of a page that scrolls as a document -- the dashboard,
 * settings, a connection's home. One padding and one gap everywhere; the
 * width cap says whether the page is a form (prose) or a board (full).
 */
export function PageContainer({
  width = "full",
  className,
  children,
}: {
  width?: keyof typeof WIDTHS
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col p-4 sm:p-6">
      <div className={cn("mx-auto flex w-full flex-col gap-6", WIDTHS[width], className)}>
        {children}
      </div>
    </div>
  )
}

/**
 * A page's own title, for pages that are not full-bleed: what this page is,
 * one line on what it is for, and its main action. The one h1 on the page --
 * the header's breadcrumb says where you are, this says what you are looking at.
 */
export function PageHeading({
  title,
  description,
  actions,
  icon: Icon,
  meta,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  /** A small mark before the title: the section's icon, a project's stack. */
  icon?: React.ComponentType<{ className?: string }>
  /** A badge or count beside the title. */
  meta?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="page-heading"
      className={cn("flex flex-wrap items-end justify-between gap-x-4 gap-y-3", className)}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2.5">
          {Icon && <Icon className="text-muted-foreground size-5 shrink-0" />}
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {meta}
        </div>
        {description && (
          <p className="text-muted-foreground mt-1 max-w-prose text-sm">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
