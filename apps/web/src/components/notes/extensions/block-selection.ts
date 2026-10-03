import { Extension } from "@tiptap/core"
import { SuggestionPluginKey } from "@tiptap/suggestion"
import type { Node as PMNode } from "@tiptap/pm/model"
import {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  SelectionRange,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"
import type { Mappable } from "@tiptap/pm/transform"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"

/**
 * Notion's block selection: whole top-level blocks picked as units, rather
 * than the text inside them.
 *
 * It is a real ProseMirror selection, spanning from the start of the first
 * block to the end of the last, so copy, cut, delete and undo treat it the
 * way they treat any range -- only the native highlight is hidden and a tint
 * is drawn over each block instead. `anchor` and `head` are the start
 * positions of the block the selection began on and the block it reaches,
 * so shift+arrows grow and shrink it from the right end.
 */
export class BlockSelection extends Selection {
  readonly anchorBlock: number
  readonly headBlock: number

  constructor(doc: PMNode, anchorBlock: number, headBlock: number) {
    const first = Math.min(anchorBlock, headBlock)
    const last = Math.max(anchorBlock, headBlock)
    const end = last + (doc.nodeAt(last)?.nodeSize ?? 0)
    const $from = doc.resolve(first)
    const $to = doc.resolve(end)
    super($from, $to, [new SelectionRange($from, $to)])
    this.anchorBlock = anchorBlock
    this.headBlock = headBlock
  }

  /** The selection over the top-level blocks that hold `anchor` and `head`. */
  static between(doc: PMNode, anchor: number, head: number): BlockSelection {
    return new BlockSelection(doc, blockStart(doc, anchor), blockStart(doc, head))
  }

  map(doc: PMNode, mapping: Mappable): Selection {
    const from = mapping.map(this.from, 1)
    const to = mapping.map(this.to, -1)
    if (from >= to) return Selection.near(doc.resolve(Math.min(from, doc.content.size)))
    const forward = this.anchorBlock <= this.headBlock
    return forward
      ? BlockSelection.between(doc, from, to - 1)
      : BlockSelection.between(doc, to - 1, from)
  }

  eq(other: Selection): boolean {
    return (
      other instanceof BlockSelection &&
      other.anchorBlock === this.anchorBlock &&
      other.headBlock === this.headBlock
    )
  }

  override toJSON() {
    return { type: "block", anchor: this.anchorBlock, head: this.headBlock }
  }

  static override fromJSON(doc: PMNode, json: { anchor: number; head: number }) {
    return new BlockSelection(doc, json.anchor, json.head)
  }

  /** Each selected block's start, in document order. */
  blocks(): number[] {
    const out: number[] = []
    this.$from.doc.nodesBetween(this.from, this.to, (_node, pos) => {
      out.push(pos)
      return false
    })
    return out
  }
}
// The native highlight is hidden; the decorations below draw the tint.
BlockSelection.prototype.visible = false
Selection.jsonID("block", BlockSelection)

/** The start of the top-level block holding `pos` (a position between blocks is its own). */
export function blockStart(doc: PMNode, pos: number): number {
  const clamped = Math.max(0, Math.min(pos, doc.content.size - 1))
  const $pos = doc.resolve(clamped)
  return $pos.depth === 0 ? clamped : $pos.before(1)
}

/** The top-level block before or after the one starting at `pos`, or null at either end. */
function sibling(doc: PMNode, pos: number, dir: -1 | 1): number | null {
  if (dir === 1) {
    const next = pos + (doc.nodeAt(pos)?.nodeSize ?? 0)
    return next < doc.content.size ? next : null
  }
  if (pos === 0) return null
  return blockStart(doc, pos - 1)
}

/** A text cursor at the end of the block starting at `pos`, or the nearest place one fits. */
function cursorAtEnd(doc: PMNode, pos: number): Selection {
  const end = pos + (doc.nodeAt(pos)?.nodeSize ?? 0)
  return Selection.near(doc.resolve(end), -1)
}

/** Selects the blocks a band dragged over the page touches -- or none, which leaves a cursor. */
export function selectBlocksInRect(
  view: EditorView,
  rect: { left: number; right: number; top: number; bottom: number },
  upward: boolean,
) {
  const { doc } = view.state
  const hit: number[] = []
  doc.forEach((_node, pos) => {
    const dom = view.nodeDOM(pos) as HTMLElement | null
    if (!dom?.getBoundingClientRect) return
    const box = dom.getBoundingClientRect()
    if (box.bottom >= rect.top && box.top <= rect.bottom && box.right >= rect.left && box.left <= rect.right)
      hit.push(pos)
  })
  const current = view.state.selection
  if (hit.length === 0) {
    if (current instanceof BlockSelection)
      view.dispatch(view.state.tr.setSelection(cursorAtEnd(doc, current.headBlock)))
    return
  }
  // Dragged upwards, the head is the top block, so shift+arrows grow from there.
  const first = hit[0]!
  const last = hit[hit.length - 1]!
  const next = upward ? new BlockSelection(doc, last, first) : new BlockSelection(doc, first, last)
  if (!current.eq(next)) view.dispatch(view.state.tr.setSelection(next))
}

/** Replaces the selected blocks with one empty paragraph, the cursor in it. */
function clearInto(state: EditorState): Transaction {
  const { from, to } = state.selection
  const tr = state.tr.replaceRangeWith(from, to, state.schema.nodes.paragraph!.create())
  return tr.setSelection(TextSelection.create(tr.doc, from + 1))
}

/**
 * Esc on text picks the block (or blocks) it is in; with blocks picked,
 * arrows move the pick, shift+arrows grow it, Enter goes back to writing at
 * its end and Esc drops it. Backspace and Delete remove the blocks, and a
 * typed character replaces them, as it would a text selection.
 */
export const BlockSelectionExtension = Extension.create({
  name: "blockSelection",
  // Ahead of the gap cursor, which would otherwise take the arrows between atoms.
  priority: 1000,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("blockSelection"),
        props: {
          decorations(state) {
            const sel = state.selection
            if (!(sel instanceof BlockSelection)) return null
            return DecorationSet.create(
              state.doc,
              sel.blocks().map((pos) =>
                Decoration.node(pos, pos + state.doc.nodeAt(pos)!.nodeSize, {
                  class: "ucch-block-selected",
                }),
              ),
            )
          },
          handleKeyDown(view, event) {
            const { state } = view
            const sel = state.selection
            const { doc } = state

            if (!(sel instanceof BlockSelection)) {
              if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return false
              // The slash menu's Esc closes the menu, not this.
              if (SuggestionPluginKey.getState(state)?.active) return false
              // A selected node that is itself a top-level block, or the text the cursor is in.
              const anchor = sel instanceof NodeSelection ? sel.from : sel.anchor
              const head = sel instanceof NodeSelection ? sel.from : sel.head
              view.dispatch(state.tr.setSelection(BlockSelection.between(doc, anchor, head)))
              return true
            }

            const mod = event.metaKey || event.ctrlKey
            switch (event.key) {
              case "Escape":
              case "Enter":
                if (mod || event.altKey) return false
                view.dispatch(state.tr.setSelection(cursorAtEnd(doc, sel.headBlock)).scrollIntoView())
                return true
              case "ArrowUp":
              case "ArrowDown": {
                if (mod || event.altKey) return false
                const dir = event.key === "ArrowUp" ? -1 : 1
                if (event.shiftKey) {
                  const head = sibling(doc, sel.headBlock, dir)
                  if (head !== null)
                    view.dispatch(state.tr.setSelection(new BlockSelection(doc, sel.anchorBlock, head)).scrollIntoView())
                  return true
                }
                const edge = dir === -1 ? sel.from : blockStart(doc, sel.to - 1)
                const next = sibling(doc, edge, dir) ?? edge
                view.dispatch(state.tr.setSelection(new BlockSelection(doc, next, next)).scrollIntoView())
                return true
              }
              case "ArrowLeft":
              case "ArrowRight":
                if (mod || event.altKey || event.shiftKey) return false
                view.dispatch(
                  state.tr.setSelection(
                    event.key === "ArrowLeft"
                      ? Selection.near(doc.resolve(sel.from), 1)
                      : cursorAtEnd(doc, blockStart(doc, sel.to - 1)),
                  ),
                )
                return true
              case "Backspace":
              case "Delete":
                view.dispatch(state.tr.deleteSelection().scrollIntoView())
                return true
            }
            // A printable character: the blocks give way to a line that holds it.
            if (event.key.length === 1 && !mod && !event.altKey) {
              view.dispatch(clearInto(state))
              return false
            }
            return false
          },
        },
      }),
    ]
  },
})
