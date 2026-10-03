"use client"

import * as React from "react"
import { mergeAttributes, Node, type JSONContent } from "@tiptap/core"
import {
  NodeViewContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react"
import { PaletteIcon } from "lucide-react"

import { EmojiPicker } from "@/components/notes/emoji-picker"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { containerOpen, matchHtmlContainer } from "@/lib/markdown-containers"
import { cn } from "@/lib/utils"

export const CALLOUT_COLORS = ["default", "gray", "blue", "green", "yellow", "red", "purple"] as const
export type CalloutColor = (typeof CALLOUT_COLORS)[number]

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: { emoji?: string; color?: CalloutColor }) => ReturnType
      unsetCallout: () => ReturnType
    }
  }
}

/**
 * Notion's callout: a tinted box with an emoji, holding any blocks.
 *
 * In Markdown it is a `<div data-type="callout">` around ordinary Markdown,
 * which GitHub shows as the text inside; the tokenizer reads the same
 * shape back so an export re-imports as a callout.
 */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  draggable: true,

  addAttributes() {
    return {
      emoji: {
        default: "💡",
        parseHTML: (element) => element.getAttribute("data-emoji") || "💡",
        renderHTML: (attrs) => ({ "data-emoji": attrs.emoji }),
      },
      color: {
        default: "default",
        parseHTML: (element) => {
          const value = element.getAttribute("data-color")
          return CALLOUT_COLORS.includes(value as CalloutColor) ? value : "default"
        },
        renderHTML: (attrs) => ({ "data-color": attrs.color }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-type='callout']" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "callout", class: "ucch-callout" }), 0]
  },

  markdownTokenName: "callout",
  markdownTokenizer: {
    name: "callout",
    level: "block",
    start: (src) => src.search(/<div\s[^>]*data-type="callout"/i),
    tokenize: (src, _tokens, lexer) => {
      const match = matchHtmlContainer(src, "div", "callout")
      if (!match) return undefined
      return {
        type: "callout",
        raw: match.raw,
        attrs: match.attrs,
        tokens: lexer.blockTokens(match.inner.trim()),
      }
    },
  },
  parseMarkdown: (token, helpers) => {
    const attrs = (token.attrs ?? {}) as Record<string, string>
    const children = helpers.parseChildren(token.tokens ?? [])
    return helpers.createNode(
      "callout",
      { emoji: attrs["data-emoji"] || "💡", color: attrs["data-color"] || "default" },
      children.length ? children : [helpers.createNode("paragraph")],
    )
  },
  renderMarkdown: (node: JSONContent, helpers) => {
    const attrs = (node.attrs ?? {}) as { emoji?: string; color?: string }
    const open = containerOpen("div", {
      "data-type": "callout",
      "data-emoji": attrs.emoji,
      "data-color": attrs.color === "default" ? null : attrs.color,
    })
    return `${open}\n\n${helpers.renderChildren(node.content ?? [], "\n\n")}\n\n</div>`
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView)
  },
})

function CalloutView({ node, updateAttributes, selected }: NodeViewProps) {
  const emoji = node.attrs.emoji as string
  const color = node.attrs.color as CalloutColor
  return (
    <NodeViewWrapper
      className={cn("ucch-callout group/callout", selected && "ring-ucch-active ring-2")}
      data-color={color}
    >
      <div className="flex shrink-0 items-start gap-0.5" contentEditable={false}>
        <EmojiPicker value={emoji} onPick={(next) => updateAttributes({ emoji: next ?? "💡" })}>
          <button
            type="button"
            title="Change icon"
            className="hover:bg-foreground/10 flex size-7 items-center justify-center rounded text-lg leading-none"
          >
            {emoji}
          </button>
        </EmojiPicker>
      </div>
      <NodeViewContent className="ucch-callout-body min-w-0 flex-1" />
      <div
        className="shrink-0 opacity-0 transition-opacity group-hover/callout:opacity-100 focus-within:opacity-100"
        contentEditable={false}
      >
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" title="Colour" />}>
            <PaletteIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {CALLOUT_COLORS.map((option) => (
              <DropdownMenuItem key={option} onClick={() => updateAttributes({ color: option })}>
                <span
                  className="ucch-callout size-3.5 rounded-sm border p-0"
                  data-color={option}
                  aria-hidden
                />
                <span className="capitalize">{option}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </NodeViewWrapper>
  )
}
