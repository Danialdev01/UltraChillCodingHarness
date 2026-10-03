"use client"

import * as React from "react"
import { Extension, type Editor } from "@tiptap/core"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import {
  CopyIcon,
  GripVerticalIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  LightbulbIcon,
  PilcrowIcon,
  PlusIcon,
  TextQuoteIcon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import { BlockSelection } from "./block-selection"

/** The top-level block under the pointer, and where its box is. */
export interface BlockHover {
  pos: number
  top: number
  left: number
  height: number
}

export interface BlockHandleOptions {
  /** Called with the block the pointer is over, or null when it leaves. */
  onHover(hover: BlockHover | null): void
}

/**
 * Notion's gutter: hover a block and a `+` and a `⋮⋮` appear at its left.
 *
 * The plugin only watches the pointer and reports which top-level block it
 * is over; the buttons are React, rendered by the page beside the editor.
 * Dragging starts a native drag with ProseMirror's own `dragging` state
 * set, so the drop cursor and the move are the editor's, not ours.
 */
export const BlockHandle = Extension.create<BlockHandleOptions>({
  name: "blockHandle",

  addOptions() {
    return { onHover: () => {} }
  },

  addProseMirrorPlugins() {
    const { onHover } = this.options
    return [
      new Plugin({
        key: new PluginKey("blockHandle"),
        view(view) {
          let frame = 0
          let last: BlockHover | null = null
          /** Where the pointer was, so a changed document can be re-measured. */
          let pointerY: number | null = null
          const publish = (next: BlockHover | null) => {
            if (
              next?.pos === last?.pos &&
              next?.top === last?.top &&
              next?.left === last?.left &&
              next?.height === last?.height
            )
              return
            last = next
            onHover(next)
          }
          const measure = () => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() =>
              publish(pointerY === null ? null : blockAt(view, pointerY)),
            )
          }
          const onMove = (event: MouseEvent) => {
            pointerY = event.clientY
            measure()
          }
          const onLeave = (event: MouseEvent) => {
            // Moving onto the handles themselves is not leaving.
            const to = event.relatedTarget as HTMLElement | null
            if (to?.closest?.("[data-block-handles]")) return
            pointerY = null
            measure()
          }
          const host = view.dom.parentElement ?? view.dom
          host.addEventListener("mousemove", onMove)
          host.addEventListener("mouseleave", onLeave)
          // The page scrolls under a still pointer; the handles are fixed.
          window.addEventListener("scroll", measure, true)
          return {
            // Blocks move as the document changes; measure the same spot again.
            update: measure,
            destroy: () => {
              cancelAnimationFrame(frame)
              host.removeEventListener("mousemove", onMove)
              host.removeEventListener("mouseleave", onLeave)
              window.removeEventListener("scroll", measure, true)
            },
          }
        },
      }),
    ]
  },
})

/** The top-level block whose box spans `clientY`, if any. */
function blockAt(view: EditorView, clientY: number): BlockHover | null {
  const editorRect = view.dom.getBoundingClientRect()
  if (clientY < editorRect.top || clientY > editorRect.bottom) return null
  const doc = view.state.doc
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i)
    const dom = view.nodeDOM(pos) as HTMLElement | null
    if (dom?.getBoundingClientRect) {
      const rect = dom.getBoundingClientRect()
      if (clientY >= rect.top && clientY <= rect.bottom) {
        return { pos, top: rect.top, left: editorRect.left, height: rect.height }
      }
    }
    pos += child.nodeSize
  }
  return null
}

const TURN_INTO = [
  { label: "Text", icon: PilcrowIcon, run: (e: Editor) => e.chain().focus().setParagraph().run() },
  { label: "Heading 1", icon: Heading1Icon, run: (e: Editor) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", icon: Heading2Icon, run: (e: Editor) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", icon: Heading3Icon, run: (e: Editor) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Quote", icon: TextQuoteIcon, run: (e: Editor) => e.chain().focus().wrapIn("blockquote").run() },
  { label: "Callout", icon: LightbulbIcon, run: (e: Editor) => e.chain().focus().setCallout().run() },
]

/**
 * The two buttons beside the hovered block. Fixed-positioned from the
 * block's box; hidden while nothing is hovered or a menu owns the keys.
 */
export function BlockHandles({
  editor,
  hover,
  hidden,
}: {
  editor: Editor
  hover: BlockHover | null
  hidden?: boolean
}) {
  const [menuOpen, setMenuOpen] = React.useState(false)
  // Keep the last hover while the menu is open, so the buttons stay put.
  const pinned = React.useRef<BlockHover | null>(null)
  if (menuOpen && pinned.current) hover = pinned.current
  else pinned.current = hover
  if (!hover || (hidden && !menuOpen)) return null

  const { doc, selection } = editor.state
  // The hover is measured a frame after the document changes, and a pinned
  // one not at all, so after a delete it can point past the end, or into
  // the middle of a block -- until the next measure, show nothing.
  if (hover.pos >= doc.content.size || doc.resolve(hover.pos).depth !== 0) return null
  const node = doc.nodeAt(hover.pos)
  if (!node) return null
  // A block inside the picked blocks speaks for all of them; any other, for itself.
  const inPick =
    selection instanceof BlockSelection && hover.pos >= selection.from && hover.pos < selection.to
  const from = inPick ? selection.from : hover.pos
  const after = inPick ? selection.to : hover.pos + node.nodeSize
  const textblock = inPick
    ? selection.blocks().every((pos) => doc.nodeAt(pos)?.isTextblock)
    : node.isTextblock

  /** Picks this block; with shift, grows the current pick to reach it. */
  const select = (extend = false) => {
    const { state } = editor
    if (inPick && !extend) return
    const anchor =
      extend && state.selection instanceof BlockSelection ? state.selection.anchorBlock : hover.pos
    editor.view.dispatch(state.tr.setSelection(new BlockSelection(state.doc, anchor, hover.pos)))
  }

  const addBelow = (before: boolean) => {
    const at = before ? hover.pos : after
    // An empty paragraph, then `/` so the block menu opens in it.
    editor
      .chain()
      .insertContentAt(at, { type: "paragraph" })
      .setTextSelection(at + 1)
      .focus()
      .insertContent("/")
      .run()
  }

  return (
    <div
      data-block-handles
      className="fixed z-30 flex items-center gap-0.5"
      style={{ left: hover.left - 50, top: hover.top + Math.min(4, Math.max(0, (hover.height - 24) / 2)) }}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        title="Add a block below (alt: above)"
        className="text-muted-foreground"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => addBelow(event.altKey)}
      >
        <PlusIcon />
      </Button>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              title="Drag to move, click for options"
              className="text-muted-foreground cursor-grab active:cursor-grabbing"
            />
          }
          draggable
          onClick={(event: React.MouseEvent) => select(event.shiftKey)}
          onDragStart={(event: React.DragEvent) => {
            select()
            const dom = editor.view.nodeDOM(hover.pos) as HTMLElement | null
            event.dataTransfer.clearData()
            event.dataTransfer.setData("text/html", dom?.outerHTML ?? "")
            event.dataTransfer.effectAllowed = "copyMove"
            if (dom) event.dataTransfer.setDragImage(dom, 0, 0)
            editor.view.dragging = { slice: editor.state.selection.content(), move: true }
          }}
        >
          <GripVerticalIcon />
        </DropdownMenuTrigger>
        {/* Closed, the keys go back to the editor, where the pick still is. */}
        <DropdownMenuContent align="start" side="left" finalFocus={() => editor.view.dom}>
          <DropdownMenuItem
            onClick={() => {
              const copy = doc.slice(from, after).content.toJSON()
              editor.chain().insertContentAt(after, copy).focus(after + 1).run()
            }}
          >
            <CopyIcon /> Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => editor.chain().deleteRange({ from, to: after }).focus().run()}
          >
            <Trash2Icon /> Delete
          </DropdownMenuItem>
          {textblock && (
            <>
              <DropdownMenuSeparator />
              {TURN_INTO.map((item) => (
                <DropdownMenuItem
                  key={item.label}
                  onClick={() => {
                    const { state } = editor
                    editor.view.dispatch(
                      state.tr.setSelection(
                        TextSelection.create(state.doc, from + 1, after - 1),
                      ),
                    )
                    item.run(editor)
                  }}
                >
                  <item.icon /> {item.label}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
