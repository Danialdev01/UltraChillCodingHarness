"use client"

import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * The top bar's shared pieces. Every colour is a theme token -- the same ones
 * the sidebar is drawn with -- so a palette picked in Settings -> Theme, light
 * or dark, carries straight through: `muted-foreground` for the resting icon,
 * `muted` for hover, `ucch-active` for a lit toggle, and the status tokens
 * (`success`, `warning`, `danger`) for what a process is doing.
 */

/** 32x32, 8px corners: the bar's one size of icon button. */
export const ICON_BUTTON = cn(
  "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors duration-150",
  "focus-visible:ring-focus-ring/60 outline-none focus-visible:ring-2",
  "text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-muted/50",
  "disabled:pointer-events-none disabled:opacity-40",
  "aria-expanded:bg-muted aria-expanded:text-foreground dark:aria-expanded:bg-muted/50",
  // Lit: a toggle that is on, in the accent the theme gives "active".
  "data-[active=true]:bg-ucch-active-bg data-[active=true]:text-ucch-active",
  "[&_svg]:size-4 [&_svg]:shrink-0",
)

/**
 * A tooltip under the bar, with the shortcut set apart. The trigger is the
 * one element passed as `children`; it keeps its own `aria-label`.
 */
export function Hint({
  label,
  keys,
  children,
}: {
  label: string
  keys?: string
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="bottom">
        {label}
        {keys && <kbd className="ml-1 font-mono text-[10.5px]">{keys}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

/** An icon-only button with its tooltip and accessible name. */
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { label: string; keys?: string; active?: boolean }
>(function IconButton({ label, keys, active, className, children, ...props }, ref) {
  return (
    <Hint label={label} keys={keys}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        data-active={active ? "true" : undefined}
        className={cn(ICON_BUTTON, className)}
        {...props}
      >
        {children}
      </button>
    </Hint>
  )
})

/** The 1x18 rule between groups. */
export function Divider({ className }: { className?: string }) {
  return <span aria-hidden className={cn("bg-border mx-1 h-[18px] w-px shrink-0", className)} />
}

function noSubscribe() {
  return () => {}
}

function readIsMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/** Whether to write shortcuts with ⌘ rather than Ctrl. Assumed on the server. */
export function useIsMac(): boolean {
  return React.useSyncExternalStore(noSubscribe, readIsMac, () => true)
}

/** `⌘1` on a Mac, `Ctrl+1` elsewhere; `shift` adds ⇧ / Shift+. */
export function shortcut(mac: boolean, key: string, shift = false): string {
  if (mac) return `${shift ? "⇧" : ""}⌘${key}`
  return `Ctrl+${shift ? "Shift+" : ""}${key}`
}

/** Whether a key event is the platform's command modifier (⌘ on a Mac, Ctrl elsewhere) with nothing else. */
export function isCommandKey(event: KeyboardEvent, { shift = false }: { shift?: boolean } = {}): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey === shift
}
