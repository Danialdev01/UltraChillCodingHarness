"use client"

import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { revealRow } from "@/lib/turn-spy"
import { cn } from "@/lib/utils"

export interface RailTurn {
  id: string
  /** The prompt's first line, already cut to length. */
  preview: string
}

/** One row per turn; the row, not the 2px line, is what the pointer has to hit. */
const ROW_PX = 12
/** Past this many turns the rail stops growing and scrolls on its own. */
const MAX_ROWS = 25
/** How tall the fade at a clipped edge is. */
const FADE_PX = 16

/**
 * The conversation's minimap: a tick per turn down the chat's left edge,
 * the turn being read highlighted, a click away from any other.
 *
 * Presentational only. Which turn is active and how to get to one come from
 * `useActiveTurn`; this draws the ticks, scrolls itself once there are more
 * than fit, and handles the keyboard (one Tab stop, arrows inside).
 * Absolutely placed by its parent, which must be `relative` around the
 * scroll box (not inside it) so the rail stays put while the thread moves.
 */
export const ConversationRail = React.memo(function ConversationRail({
  turns,
  activeId,
  onSelect,
  className,
}: {
  turns: readonly RailTurn[]
  activeId: string | null
  onSelect: (id: string) => void
  className?: string
}) {
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const rowRefs = React.useRef<(HTMLButtonElement | null)[]>([])
  // One ref callback per position, the same every render, so a memoised tick
  // is not drawn again just for a new function.
  const rowRefCallbacks = React.useRef<((el: HTMLButtonElement | null) => void)[]>([])
  const rowRef = (i: number) =>
    (rowRefCallbacks.current[i] ??= (el) => {
      rowRefs.current[i] = el
    })
  // Stable for the memoised ticks, whatever the parent passes on a render.
  const selectRef = React.useRef(onSelect)
  selectRef.current = onSelect
  const select = React.useCallback((id: string) => selectRef.current(id), [])

  const total = turns.length
  const activeIndex = activeId ? turns.findIndex((t) => t.id === activeId) : -1
  /** The tick holding focus while the keyboard is in the rail; null otherwise. */
  const [focusIndex, setFocusIndex] = React.useState<number | null>(null)
  const tabStop = Math.min(focusIndex ?? (activeIndex >= 0 ? activeIndex : total - 1), total - 1)

  /** Brings a row into the rail's view by moving the rail only, never the page. */
  const reveal = React.useCallback((index: number) => {
    const scroller = scrollerRef.current
    const row = rowRefs.current[index]
    if (!scroller || !row) return
    const top = revealRow({ top: row.offsetTop, height: row.offsetHeight }, scroller)
    if (top !== null) scroller.scrollTop = top
  }, [])

  // The active tick stays in view as the reader moves through the thread.
  React.useLayoutEffect(() => {
    if (activeIndex >= 0) reveal(activeIndex)
  }, [activeIndex, reveal])

  // Fades only at an edge with more ticks past it.
  const [fade, setFade] = React.useState({ top: false, bottom: false })
  const updateFade = React.useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const top = el.scrollTop > 1
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }))
  }, [])
  React.useLayoutEffect(updateFade, [total, activeIndex, updateFade])
  React.useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const resized = new ResizeObserver(updateFade)
    resized.observe(el)
    return () => resized.disconnect()
  }, [updateFade, total >= 2])

  const move = (index: number) => {
    const next = Math.max(0, Math.min(total - 1, index))
    setFocusIndex(next)
    rowRefs.current[next]?.focus({ preventScroll: true })
    reveal(next)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Alt+arrows are the chat-wide shortcut; leave them to it.
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const at = focusIndex ?? tabStop
    const to =
      e.key === "ArrowUp" ? at - 1 : e.key === "ArrowDown" ? at + 1 : e.key === "Home" ? 0 : e.key === "End" ? total - 1 : null
    if (to === null) return
    e.preventDefault()
    move(to)
  }

  if (total < 2) return null

  const mask =
    fade.top || fade.bottom
      ? `linear-gradient(to bottom, ${fade.top ? "transparent" : "black"}, black ${FADE_PX}px, black calc(100% - ${FADE_PX}px), ${
          fade.bottom ? "transparent" : "black"
        })`
      : undefined

  return (
    <nav
      aria-label="Conversation messages"
      className={cn("flex max-h-[calc(100%-2rem)] flex-col", className)}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusIndex(null)
      }}
    >
      <div
        ref={scrollerRef}
        onScroll={updateFade}
        className="no-scrollbar relative min-h-0 overflow-y-auto overscroll-contain"
        style={{ maxHeight: ROW_PX * MAX_ROWS, maskImage: mask, WebkitMaskImage: mask }}
      >
        {turns.map((turn, i) => (
          <Tick
            key={turn.id}
            ref={rowRef(i)}
            turn={turn}
            index={i}
            total={total}
            active={i === activeIndex}
            tabbable={i === tabStop}
            onSelect={select}
            onFocusRow={setFocusIndex}
          />
        ))}
      </div>
    </nav>
  )
})

const Tick = React.memo(function Tick({
  ref,
  turn,
  index,
  total,
  active,
  tabbable,
  onSelect,
  onFocusRow,
}: {
  ref: React.Ref<HTMLButtonElement>
  turn: RailTurn
  index: number
  total: number
  active: boolean
  tabbable: boolean
  onSelect: (id: string) => void
  onFocusRow: (index: number) => void
}) {
  const n = index + 1
  return (
    <Tooltip>
      <TooltipTrigger
        delay={150}
        render={
          <button
            ref={ref}
            type="button"
            tabIndex={tabbable ? 0 : -1}
            aria-label={`Jump to message ${n} of ${total}: ${turn.preview}`}
            aria-current={active ? "true" : undefined}
            onClick={() => onSelect(turn.id)}
            onFocus={() => onFocusRow(index)}
            className="group/tick focus-visible:ring-ring flex w-full cursor-pointer items-center rounded-sm px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset"
            style={{ height: ROW_PX }}
          />
        }
      >
        <span
          aria-hidden
          className={cn(
            "h-0.5 rounded-full transition-[width,background-color] duration-150 ease-out motion-reduce:transition-none",
            active
              ? "bg-foreground w-5"
              : "bg-border-strong group-hover/tick:bg-muted-foreground group-focus-visible/tick:bg-muted-foreground w-3 group-hover/tick:w-4 group-focus-visible/tick:w-4",
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6} className="flex-col items-start gap-0.5">
        <span className="font-semibold tabular-nums">
          {n} / {total}
        </span>
        <span className="max-w-64 break-words">{turn.preview}</span>
      </TooltipContent>
    </Tooltip>
  )
})
