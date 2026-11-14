"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export type SegmentedOption<T extends string> = {
  value: T
  label: React.ReactNode
  /** Names an option whose label is an icon, or narrows below `sm`. */
  ariaLabel?: string
  icon?: React.ComponentType<{ className?: string }>
  disabled?: boolean
}

/**
 * A small set of mutually exclusive choices shown side by side: a theme
 * mode, a zoom level, which kind of document a tab shows.
 *
 * A radio group under the hood -- one tab stop, arrow keys move the choice --
 * so every segmented control in the app behaves and looks the same.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
  size = "default",
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  size?: "sm" | "default"
  className?: string
  "aria-label"?: string
  "aria-labelledby"?: string
}) {
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.filter((o) => !o.disabled)

  function onKeyDown(event: React.KeyboardEvent, current: T) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0
    if (!step || enabled.length === 0) return
    event.preventDefault()
    const at = enabled.findIndex((o) => o.value === current)
    const next = enabled[(at + step + enabled.length) % enabled.length]!
    onChange(next.value)
    buttons.current[options.indexOf(next)]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      data-slot="segmented"
      className={cn(
        "bg-muted/60 light:bg-sidebar inline-flex max-w-full items-center gap-0.5 rounded-lg border p-0.5",
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttons.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            tabIndex={checked ? 0 : -1}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, option.value)}
            className={cn(
              "inline-flex min-w-0 flex-auto items-center justify-center gap-1.5 truncate rounded-md border font-medium transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              size === "sm" ? "h-6 px-2 text-xs" : "h-7 px-2.5 text-xs",
              checked
                ? "bg-background text-foreground border-border shadow-xs light:border-border-strong light:shadow-rest light:font-semibold light:[&>svg]:text-primary"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {Icon && <Icon className="size-3.5 shrink-0" />}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
