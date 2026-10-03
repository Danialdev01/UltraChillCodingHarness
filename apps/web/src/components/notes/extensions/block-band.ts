"use client"

import * as React from "react"
import type { Editor } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"

import { BlockSelection, selectBlocksInRect } from "./block-selection"

export interface Band {
  left: number
  top: number
  width: number
  height: number
}

/** How far the pointer moves before a press becomes a band, so a click stays a click. */
const THRESHOLD = 4
/** How close to the scroller's edge the pointer must be to scroll it, and how fast. */
const EDGE = 48
const SPEED = 14

/** Presses on these keep their own meaning. */
const OWN_PRESS = "input, textarea, select, button, a, [role='menu'], [data-block-handles]"

/**
 * Notion's drag-to-select: press in the page around the text -- the margins,
 * the space above or below it -- and drag, and every block the band crosses
 * is picked. Presses inside the text are the editor's, for text selection.
 *
 * The band's start is kept in the scroller's coordinates, so it stays
 * pinned to the page while the scroller moves under it -- by the wheel, or
 * by this, near the scroller's top and bottom edges.
 */
export function useBlockBand(
  editor: Editor | null,
  root: React.RefObject<HTMLElement | null>,
): Band | null {
  const [band, setBand] = React.useState<Band | null>(null)

  React.useEffect(() => {
    const host = root.current
    if (!editor || !host) return
    const scroller = scrollParent(host)

    const onMouseDown = (down: MouseEvent) => {
      if (down.button !== 0) return
      const target = down.target as Element | null
      if (!target || editor.view.dom.contains(target) || target.closest(OWN_PRESS)) return
      // No native text selection across the page, and no focus taken from the editor.
      down.preventDefault()

      const scrollTop = () => scroller?.scrollTop ?? 0
      const startX = down.clientX
      const startY = down.clientY + scrollTop()
      let pointer = { x: down.clientX, y: down.clientY }
      let started = false
      let frame = 0

      const update = () => {
        const y0 = startY - scrollTop()
        const rect = {
          left: Math.min(startX, pointer.x),
          right: Math.max(startX, pointer.x),
          top: Math.min(y0, pointer.y),
          bottom: Math.max(y0, pointer.y),
        }
        setBand({ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top })
        selectBlocksInRect(editor.view, rect, pointer.y < y0)
      }

      const autoscroll = () => {
        frame = 0
        if (!scroller) return
        const box = scroller.getBoundingClientRect()
        const dy =
          pointer.y < box.top + EDGE ? -SPEED : pointer.y > box.bottom - EDGE ? SPEED : 0
        if (dy === 0) return
        const before = scroller.scrollTop
        scroller.scrollTop += dy
        if (scroller.scrollTop !== before) update()
        frame = requestAnimationFrame(autoscroll)
      }

      const onMove = (move: MouseEvent) => {
        pointer = { x: move.clientX, y: move.clientY }
        if (!started) {
          if (Math.hypot(pointer.x - startX, pointer.y + scrollTop() - startY) < THRESHOLD) return
          started = true
        }
        update()
        if (!frame) frame = requestAnimationFrame(autoscroll)
      }

      const onScroll = () => started && update()

      const onUp = () => {
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
        scroller?.removeEventListener("scroll", onScroll)
        cancelAnimationFrame(frame)
        setBand(null)
        const { state } = editor.view
        if (started) {
          // The keys go to the editor, so the pick can be moved, copied or deleted.
          if (state.selection instanceof BlockSelection) editor.view.focus()
        } else if (state.selection instanceof BlockSelection) {
          // A plain click beside the page drops the pick.
          editor.view.dispatch(
            state.tr.setSelection(TextSelection.near(state.doc.resolve(state.selection.to), -1)),
          )
          ;(editor.view.dom as HTMLElement).blur()
        }
      }

      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
      scroller?.addEventListener("scroll", onScroll)
    }

    host.addEventListener("mousedown", onMouseDown)
    return () => host.removeEventListener("mousedown", onMouseDown)
  }, [editor, root])

  return band
}

/** The nearest ancestor that scrolls vertically. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll") return node
  }
  return null
}
