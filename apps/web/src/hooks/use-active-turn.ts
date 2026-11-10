"use client"

import * as React from "react"

import { activeTurnIndex, initialSpy, spyReducer, type SpyEvent, type SpyState } from "@/lib/turn-spy"

/**
 * After the last scroll event, how long before a jump counts as settled, in
 * browsers without `scrollend`.
 */
const SETTLE_DEBOUNCE_MS = 150

/** A jump that never reports settling (a cancelled smooth scroll) lets go after this. */
const SETTLE_CAP_MS = 2000

/** Keys that scroll the box by hand when it, or something in it, has focus. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "])

/** Finds a turn's anchor inside this chat's box only: two chats can share a page. */
function anchorOf(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(id)}"]`)
}

/**
 * Which turn the reader is on, and a way to go to one.
 *
 * Scroll-spy over the turns' anchors (`data-turn-id`) in `containerRef`: one
 * passive scroll listener, throttled to a frame, and the turns' tops measured
 * only when something has moved them (the list or a turn resized, a turn was
 * added), never per scroll event. `scrollToTurn` jumps with a lock, so the
 * highlight goes straight to the clicked turn instead of running through every
 * one the smooth scroll passes; scrolling by hand mid-jump lets go of it.
 * `resetKey` (the session) clears everything when it changes.
 */
export function useActiveTurn(
  containerRef: React.RefObject<HTMLElement | null>,
  turnIds: readonly string[],
  resetKey?: unknown,
): { activeId: string | null; scrollToTurn: (id: string) => void } {
  const [state, setState] = React.useState<SpyState>(initialSpy)
  // The state as of the last event, read by listeners attached once.
  const stateRef = React.useRef(state)
  const send = React.useCallback((event: SpyEvent) => {
    const next = spyReducer(stateRef.current, event)
    if (next === stateRef.current) return
    stateRef.current = next
    setState(next)
  }, [])

  const idsRef = React.useRef(turnIds)
  idsRef.current = turnIds
  /** The turns' tops in content coordinates; null when something may have moved them. */
  const topsRef = React.useRef<number[] | null>(null)
  const frameRef = React.useRef(0)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const capRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearTimers = React.useCallback(() => {
    clearTimeout(debounceRef.current)
    clearTimeout(capRef.current)
  }, [])

  /** The id the scroll position says, measuring the tops first if they are stale. */
  const readPosition = React.useCallback((): string | null => {
    const box = containerRef.current
    const ids = idsRef.current
    if (!box || ids.length === 0) return null
    if (!topsRef.current || topsRef.current.length !== ids.length) {
      const origin = box.getBoundingClientRect().top - box.scrollTop
      const tops: number[] = []
      for (const id of ids) {
        const el = anchorOf(box, id)
        // A turn not drawn yet sits where the one before it does, which keeps
        // the list in order and never picks it.
        tops.push(el ? el.getBoundingClientRect().top - origin : (tops[tops.length - 1] ?? 0))
      }
      topsRef.current = tops
    }
    const index = activeTurnIndex(topsRef.current, box)
    return ids[index] ?? null
  }, [containerRef])

  /** At most one reading per frame, however many scroll or resize events land in it. */
  const schedule = React.useCallback(() => {
    if (frameRef.current) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0
      if (!stateRef.current.locked) send({ type: "spy", id: readPosition() })
    })
  }, [readPosition, send])

  const settle = React.useCallback(() => {
    clearTimers()
    send({ type: "settle" })
  }, [clearTimers, send])

  // Listeners, once per box.
  React.useEffect(() => {
    const box = containerRef.current
    if (!box) return
    const hasScrollEnd = "onscrollend" in box

    const onScroll = () => {
      if (stateRef.current.locked) {
        if (!hasScrollEnd) {
          clearTimeout(debounceRef.current)
          debounceRef.current = setTimeout(settle, SETTLE_DEBOUNCE_MS)
        }
        return
      }
      schedule()
    }
    const onScrollEnd = () => {
      if (stateRef.current.locked) settle()
    }
    // The reader taking over: wheel, touch, a drag on the scrollbar, a key.
    const onManual = (e: Event) => {
      if (!stateRef.current.locked) return
      if (e instanceof KeyboardEvent && !SCROLL_KEYS.has(e.key)) return
      clearTimers()
      send({ type: "manual", id: readPosition() })
    }

    box.addEventListener("scroll", onScroll, { passive: true })
    box.addEventListener("scrollend", onScrollEnd)
    box.addEventListener("wheel", onManual, { passive: true })
    box.addEventListener("touchmove", onManual, { passive: true })
    box.addEventListener("pointerdown", onManual)
    box.addEventListener("keydown", onManual)

    // Anything that moves the turns: the box resizing, or the content in it
    // (a streaming reply, an image loading, a section opened).
    const resized = new ResizeObserver(() => {
      topsRef.current = null
      schedule()
    })
    resized.observe(box)
    if (box.firstElementChild) resized.observe(box.firstElementChild)

    return () => {
      box.removeEventListener("scroll", onScroll)
      box.removeEventListener("scrollend", onScrollEnd)
      box.removeEventListener("wheel", onManual)
      box.removeEventListener("touchmove", onManual)
      box.removeEventListener("pointerdown", onManual)
      box.removeEventListener("keydown", onManual)
      resized.disconnect()
      cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
      clearTimers()
    }
  }, [clearTimers, containerRef, readPosition, schedule, send, settle])

  // A turn added or gone: measure again.
  const idsKey = turnIds.join("\n")
  React.useEffect(() => {
    topsRef.current = null
    schedule()
  }, [idsKey, schedule])

  // Another session: nothing carries over.
  React.useEffect(() => {
    clearTimers()
    topsRef.current = null
    send({ type: "reset" })
    schedule()
  }, [resetKey, clearTimers, schedule, send])

  const scrollToTurn = React.useCallback(
    (id: string) => {
      const box = containerRef.current
      const el = box && anchorOf(box, id)
      if (!box || !el) return
      // The anchor's own scroll margin is the clearance it asks for above it;
      // nothing sticky sits inside the box, so that is the whole offset.
      const margin = Number.parseFloat(getComputedStyle(el).scrollMarginTop) || 0
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - margin
      const target = Math.max(0, Math.min(top, box.scrollHeight - box.clientHeight))

      clearTimers()
      send({ type: "jump", id })
      // Already there: no scroll will come to settle it.
      if (Math.abs(target - box.scrollTop) < 1) {
        send({ type: "settle" })
        return
      }
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      box.scrollTo({ top: target, behavior: reduced ? "auto" : "smooth" })
      capRef.current = setTimeout(settle, SETTLE_CAP_MS)
    },
    [clearTimers, containerRef, send, settle],
  )

  return { activeId: state.activeId, scrollToTurn }
}

/** Whether a key event is aimed at something the user types into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']") !== null
}

/**
 * Alt+Up / Alt+Down: the turn before or after the active one, from anywhere in
 * the chat (`scopeRef`) that is not a text field -- in the composer the same
 * keys walk the prompt history. "Anywhere" includes the page, or a region
 * around the chat, holding focus when the last click landed in this chat.
 */
export function useTurnShortcuts(
  scopeRef: React.RefObject<HTMLElement | null>,
  turnIds: readonly string[],
  activeId: string | null,
  onSelect: (id: string) => void,
): void {
  const latest = React.useRef({ turnIds, activeId, onSelect })
  latest.current = { turnIds, activeId, onSelect }

  React.useEffect(() => {
    let pointerInside = false
    const onPointer = (e: PointerEvent) => {
      pointerInside = !!scopeRef.current && e.target instanceof Node && scopeRef.current.contains(e.target)
    }
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
      const scope = scopeRef.current
      if (!scope || isTyping(e.target)) return
      const target = e.target instanceof Node ? e.target : null
      // Clicking text focuses nothing, or a focusable region around the whole
      // chat (the skip link's target): both still count when the click was here.
      const inScope = !!target && (scope.contains(target) || (pointerInside && target.contains(scope)))
      if (!inScope) return
      const { turnIds: ids, activeId: current, onSelect: select } = latest.current
      if (ids.length < 2) return
      const at = current ? ids.indexOf(current) : -1
      const next = e.key === "ArrowUp" ? Math.max(0, at - 1) : Math.min(ids.length - 1, at + 1)
      const id = ids[next]
      if (next === at || !id) return
      e.preventDefault()
      select(id)
    }
    document.addEventListener("pointerdown", onPointer, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onPointer, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [scopeRef])
}
