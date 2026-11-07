import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A titled group of settings: a heading above a bordered card of rows.
 *
 * Every settings page is built from these, so a page reads as a stack of
 * sections, and a row's label, description and control always sit in the
 * same places -- whichever page it is on.
 */
export function SettingsSection({
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
  bare,
  plain,
  id,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  /** A button or menu beside the heading: "Add key", "Invite". */
  action?: React.ReactNode
  children?: React.ReactNode
  className?: string
  /**
   * Content that is not rows -- a table, a chart, a form -- padded inside the
   * card instead of divided into rows.
   */
  bare?: boolean
  /** Content that brings its own cards (a grid of figures): no card around it. */
  plain?: boolean
  id?: string
}) {
  const headingId = React.useId()
  return (
    <section aria-labelledby={headingId} id={id} className={cn("flex flex-col gap-2.5", className)}>
      <div className="flex min-h-7 items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 id={headingId} className="flex items-center gap-2 text-sm font-semibold">
            {Icon && <Icon className="text-muted-foreground size-4 shrink-0" />}
            {title}
          </h2>
          {description && (
            <p className="text-muted-foreground mt-0.5 max-w-prose text-xs">{description}</p>
          )}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {plain
        ? children
        : children !== undefined && children !== null && children !== false && (
        <div
          className={cn(
            "bg-card rounded-lg border",
            bare ? "p-4 *:first:mt-0" : "divide-y",
          )}
        >
          {children}
        </div>
      )}
    </section>
  )
}

/**
 * One setting: what it is and what it does on the left, its control on the
 * right. Below `sm` the control drops under the text rather than squeezing it.
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  children,
  className,
  stack,
}: {
  label: React.ReactNode
  description?: React.ReactNode
  /** The control's id, so clicking the label focuses or toggles it. */
  htmlFor?: string
  children?: React.ReactNode
  className?: string
  /** The control is wide (a text field, a list): put it under the text. */
  stack?: boolean
}) {
  const Label = htmlFor ? "label" : "div"
  return (
    <div
      data-slot="settings-row"
      className={cn(
        "flex flex-col gap-3 px-4 py-3",
        !stack && "sm:flex-row sm:items-center sm:justify-between sm:gap-6",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </Label>
        {description && <div className="text-muted-foreground mt-0.5 text-xs">{description}</div>}
      </div>
      {children !== undefined && (
        <div className={cn("flex min-w-0 items-center gap-2", !stack && "sm:shrink-0 sm:justify-end")}>
          {children}
        </div>
      )}
    </div>
  )
}
