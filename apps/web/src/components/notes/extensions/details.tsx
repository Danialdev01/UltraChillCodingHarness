"use client"

import * as React from "react"
import { mergeAttributes, Node, type JSONContent } from "@tiptap/core"
import { TextSelection } from "@tiptap/pm/state"
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react"
import { ChevronRightIcon } from "lucide-react"

import { containerOpen, matchHtmlContainer } from "@/lib/markdown-containers"
import { cn } from "@/lib/utils"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    details: {
      setDetails: () => ReturnType
      unsetDetails: () => ReturnType
    }
  }
}

/**
 * A toggle: one line that folds a set of blocks under it.
 *
 * Three nodes, as in HTML: `details` holds a `summary` and the content.
 * The open state is an attribute -- folded or not is part of the page, as
 * it is in Notion -- and the content is hidden with CSS when closed, so it
 * stays in the document and in search.
 */
export const Details = Node.create({
  name: "details",
  group: "block",
  content: "detailsSummary detailsContent",
  defining: true,
  isolating: true,
  draggable: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (element) => element.hasAttribute("open"),
        renderHTML: (attrs) => (attrs.open ? { open: "" } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: "details" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["details", mergeAttributes(HTMLAttributes, { class: "ucch-details" }), 0]
  },

  markdownTokenName: "details",
  markdownTokenizer: {
    name: "details",
    level: "block",
    start: (src) => src.search(/<details(\s|>)/i),
    tokenize: (src, _tokens, lexer) => {
      const match = matchHtmlContainer(src, "details")
      if (!match) return undefined
      const summary = /^\s*<summary>([\s\S]*?)<\/summary>/i.exec(match.inner)
      const body = summary ? match.inner.slice(summary[0].length) : match.inner
      return {
        type: "details",
        raw: match.raw,
        attrs: match.attrs,
        summary: lexer.inlineTokens(summary?.[1]?.trim() ?? ""),
        tokens: lexer.blockTokens(body.trim()),
      }
    },
  },
  parseMarkdown: (token, helpers) => {
    const attrs = (token.attrs ?? {}) as Record<string, string>
    const children = helpers.parseChildren(token.tokens ?? [])
    return helpers.createNode("details", { open: "open" in attrs }, [
      helpers.createNode("detailsSummary", undefined, helpers.parseInline(token.summary ?? [])),
      helpers.createNode(
        "detailsContent",
        undefined,
        children.length ? children : [helpers.createNode("paragraph")],
      ),
    ])
  },
  renderMarkdown: (node: JSONContent, helpers) => {
    const [summary, content] = node.content ?? []
    const open = containerOpen("details", { open: Boolean(node.attrs?.open) })
    const title = summary ? helpers.renderChildren(summary.content ?? []) : ""
    const body = content ? helpers.renderChildren(content.content ?? [], "\n\n") : ""
    return `${open}\n<summary>${title}</summary>\n\n${body}\n\n</details>`
  },

  addCommands() {
    return {
      setDetails:
        () =>
        ({ state, chain }) => {
          const { $from, $to } = state.selection
          const range = $from.blockRange($to)
          if (!range) return false
          const slice = state.doc.slice(range.start, range.end)
          const blocks: JSONContent[] = []
          slice.content.forEach((child) => blocks.push(child.toJSON() as JSONContent))
          // The first line becomes the summary; the rest fold under it.
          const first = blocks[0]
          const summary =
            first && first.type === "paragraph" ? (first.content ?? []) : []
          const body = first && first.type === "paragraph" ? blocks.slice(1) : blocks
          return chain()
            .insertContentAt(
              { from: range.start, to: range.end },
              {
                type: this.name,
                attrs: { open: true },
                content: [
                  { type: "detailsSummary", content: summary },
                  {
                    type: "detailsContent",
                    content: body.length ? body : [{ type: "paragraph" }],
                  },
                ],
              },
            )
            // Into the summary, at its end: details(1) + summary(1) + text.
            .setTextSelection(range.start + 2 + summaryLength(summary))
            .run()
        },
      unsetDetails:
        () =>
        ({ state, chain }) => {
          const { $from } = state.selection
          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth)
            if (node.type.name !== this.name) continue
            const from = $from.before(depth)
            const [summary, content] = [node.child(0), node.child(1)]
            const blocks: JSONContent[] = [
              { type: "paragraph", content: summary.content.toJSON() as JSONContent[] },
            ]
            content.content.forEach((child) => blocks.push(child.toJSON() as JSONContent))
            return chain()
              .insertContentAt({ from, to: from + node.nodeSize }, blocks)
              .run()
          }
          return false
        },
    }
  },

  addKeyboardShortcuts() {
    return {
      // Enter at the end of the summary goes into the content, opening it.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty || $from.parent.type.name !== "detailsSummary") return false
        if ($from.parentOffset !== $from.parent.content.size) return false
        const detailsPos = $from.before($from.depth - 1)
        const details = editor.state.doc.nodeAt(detailsPos)
        if (!details) return false
        const contentStart = detailsPos + 1 + details.child(0).nodeSize + 1
        return editor
          .chain()
          .command(({ tr }) => {
            if (!details.attrs.open) tr.setNodeMarkup(detailsPos, undefined, { ...details.attrs, open: true })
            tr.setSelection(TextSelection.near(tr.doc.resolve(contentStart + 1)))
            return true
          })
          .run()
      },
      // Backspace in an empty summary unwraps the toggle.
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty || $from.parent.type.name !== "detailsSummary") return false
        if ($from.parent.content.size !== 0 || $from.parentOffset !== 0) return false
        return editor.commands.unsetDetails()
      },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(DetailsView)
  },
})

/** The size of inline content as ProseMirror counts it. */
function summaryLength(content: JSONContent[]): number {
  return content.reduce((n, node) => n + (node.type === "text" ? (node.text ?? "").length : 1), 0)
}

export const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "inline*",
  defining: true,
  selectable: false,
  parseHTML() {
    return [{ tag: "summary" }]
  },
  renderHTML({ HTMLAttributes }) {
    return ["summary", mergeAttributes(HTMLAttributes, { class: "ucch-details-summary" }), 0]
  },
})

export const DetailsContent = Node.create({
  name: "detailsContent",
  content: "block+",
  defining: true,
  selectable: false,
  parseHTML() {
    return [{ tag: "div[data-type='details-content']" }]
  },
  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "details-content", class: "ucch-details-content" }),
      0,
    ]
  },
})

function DetailsView({ node, updateAttributes, selected }: NodeViewProps) {
  const open = node.attrs.open as boolean
  return (
    <NodeViewWrapper
      className={cn("ucch-details", selected && "ring-ucch-active rounded ring-2")}
      data-open={open ? "true" : "false"}
    >
      <button
        type="button"
        contentEditable={false}
        aria-label={open ? "Collapse" : "Expand"}
        aria-expanded={open}
        className="text-muted-foreground hover:bg-muted hover:text-foreground mt-[0.2em] flex size-5 shrink-0 items-center justify-center rounded"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => updateAttributes({ open: !open })}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
      </button>
      <NodeViewContent className="min-w-0 flex-1" />
    </NodeViewWrapper>
  )
}
