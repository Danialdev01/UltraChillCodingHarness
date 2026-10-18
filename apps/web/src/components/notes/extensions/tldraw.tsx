"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { mergeAttributes, Node } from "@tiptap/core"
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react"
import { PenToolIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tldraw: {
      insertTldraw: () => ReturnType
    }
  }
}

const TldrawFrame = dynamic(() => import("./tldraw-frame").then((m) => m.TldrawFrame), {
  ssr: false,
  loading: () => <Skeleton className="size-full rounded-none" />,
})

/**
 * A freehand whiteboard, drawn with tldraw and kept as its own snapshot
 * inside the page. The snapshot is an object attribute; ProseMirror carries
 * it through JSON untouched, and the clipboard copy is a JSON string.
 */
export const TldrawBlock = Node.create({
  name: "tldraw",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      snapshot: {
        default: null,
        parseHTML: (element) => {
          try {
            return JSON.parse(element.getAttribute("data-snapshot") ?? "null")
          } catch {
            return null
          }
        },
        renderHTML: (attrs) => ({ "data-snapshot": JSON.stringify(attrs.snapshot) }),
      },
      height: { default: 480 },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-type='tldraw']" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "tldraw" })]
  },

  renderMarkdown: () => "<!-- whiteboard omitted -->",

  addCommands() {
    return {
      insertTldraw:
        () =>
        ({ chain }) =>
          chain()
            .insertContent([{ type: this.name }, { type: "paragraph" }])
            .run(),
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(TldrawView)
  },
})

function TldrawView({ node, updateAttributes, selected }: NodeViewProps) {
  const dark = useTheme().resolvedMode === "dark"
  const height = node.attrs.height as number

  return (
    <NodeViewWrapper data-drag-handle>
      <div className={cn("ucch-note-card", selected && "ring-ucch-active ring-2")}>
        <div className="ucch-note-card-head">
          <PenToolIcon className="size-3" /> whiteboard
        </div>
        {/* The frame owns its keys: arrows, delete and shortcuts belong to
            the canvas while the pointer is in it, not to the document. */}
        <div
          className="relative"
          style={{ height }}
          contentEditable={false}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <TldrawFrame
            snapshot={node.attrs.snapshot}
            dark={dark}
            onChange={(snapshot) => updateAttributes({ snapshot })}
          />
        </div>
      </div>
    </NodeViewWrapper>
  )
}
