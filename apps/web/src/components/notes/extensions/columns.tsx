import { mergeAttributes, Node, type Editor, type JSONContent } from "@tiptap/core"
import type { ResolvedPos } from "@tiptap/pm/model"
import { TextSelection } from "@tiptap/pm/state"

import { containerOpen, matchHtmlContainer, splitColumns } from "@/lib/markdown-containers"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    columns: {
      insertColumns: (count: 2 | 3) => ReturnType
    }
  }
}

/**
 * Two or three columns side by side, each holding any blocks.
 *
 * No node view: a grid in CSS is all the layout needs, and letting
 * ProseMirror own the DOM keeps typing across columns ordinary. Tab moves
 * to the next column; the block goes away when every column is empty and
 * backspace is pressed in the first.
 */
export const Columns = Node.create({
  name: "columns",
  group: "block",
  content: "column{2,3}",
  defining: true,
  isolating: true,
  draggable: true,

  addAttributes() {
    return {
      count: {
        default: 2,
        parseHTML: (element) => (element.getAttribute("data-count") === "3" ? 3 : 2),
        renderHTML: (attrs) => ({ "data-count": attrs.count }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-type='columns']" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "columns", class: "ucch-columns" }), 0]
  },

  markdownTokenName: "columns",
  markdownTokenizer: {
    name: "columns",
    level: "block",
    start: (src) => src.search(/<div\s[^>]*data-type="columns"/i),
    tokenize: (src, _tokens, lexer) => {
      const match = matchHtmlContainer(src, "div", "columns")
      if (!match) return undefined
      const columns = splitColumns(match.inner)
      if (columns.length < 2) return undefined
      return {
        type: "columns",
        raw: match.raw,
        columns: columns.slice(0, 3).map((inner) => lexer.blockTokens(inner)),
      }
    },
  },
  parseMarkdown: (token, helpers) => {
    const columns = (token.columns ?? []) as { type?: string }[][]
    return helpers.createNode(
      "columns",
      { count: columns.length === 3 ? 3 : 2 },
      columns.map((tokens) => {
        const children = helpers.parseChildren(tokens as never)
        return helpers.createNode(
          "column",
          undefined,
          children.length ? children : [helpers.createNode("paragraph")],
        )
      }),
    )
  },
  renderMarkdown: (node: JSONContent, helpers) => {
    const open = containerOpen("div", { "data-type": "columns", "data-count": node.attrs?.count })
    const columns = (node.content ?? []).map(
      (column) =>
        `<div data-type="column">\n\n${helpers.renderChildren(column.content ?? [], "\n\n")}\n\n</div>`,
    )
    return `${open}\n${columns.join("\n")}\n</div>`
  },

  addCommands() {
    return {
      insertColumns:
        (count) =>
        ({ chain, state }) => {
          const at = state.selection.$from.before(1)
          const block = state.selection.$from.node(1)
          // Replace the empty block the command was typed in; otherwise add after it.
          const from = block.content.size === 0 ? at : at + block.nodeSize
          const to = block.content.size === 0 ? at + block.nodeSize : from
          return chain()
            .insertContentAt(
              { from, to },
              [
                {
                  type: this.name,
                  attrs: { count },
                  content: Array.from({ length: count }, () => ({
                    type: "column",
                    content: [{ type: "paragraph" }],
                  })),
                },
                { type: "paragraph" },
              ],
            )
            // Into the first column's paragraph: columns, column, paragraph.
            .setTextSelection(from + 3)
            .run()
        },
    }
  },

  addKeyboardShortcuts() {
    const jump =
      (direction: 1 | -1) =>
      ({ editor }: { editor: Editor }) => {
        const { $from } = editor.state.selection
        const depth = columnDepth($from)
        if (!depth) return false
        const columns = $from.node(depth - 1)
        const next = $from.index(depth - 1) + direction
        if (next < 0 || next >= columns.childCount) return false
        let pos = $from.before(depth - 1) + 1
        for (let i = 0; i < next; i++) pos += columns.child(i).nodeSize
        const tr = editor.state.tr
        tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)))
        editor.view.dispatch(tr.scrollIntoView())
        return true
      }
    return {
      Tab: jump(1),
      "Shift-Tab": jump(-1),
      // Backspace at the start of an all-empty block removes it.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty || $from.parentOffset !== 0) return false
        const depth = columnDepth($from)
        if (!depth) return false
        const columns = $from.node(depth - 1)
        if (columns.textContent.length > 0) return false
        const from = $from.before(depth - 1)
        return editor.commands.insertContentAt(
          { from, to: from + columns.nodeSize },
          { type: "paragraph" },
        )
      },
    }
  },
})

/** The depth of the column the position is in, or 0 outside one. */
function columnDepth($pos: ResolvedPos): number {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === "column") return depth
  }
  return 0
}

export const Column = Node.create({
  name: "column",
  content: "block+",
  defining: true,
  isolating: true,
  selectable: false,

  parseHTML() {
    return [{ tag: "div[data-type='column']" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "column", class: "ucch-column" }), 0]
  },
})
