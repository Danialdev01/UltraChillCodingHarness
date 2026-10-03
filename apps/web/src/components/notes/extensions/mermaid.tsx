"use client"

import * as React from "react"
import { mergeAttributes, Node, type JSONContent } from "@tiptap/core"
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react"
import { GitBranchIcon } from "lucide-react"

import { useMermaidSvg } from "@/components/diagrams/mermaid-preview"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mermaid: {
      insertMermaid: () => ReturnType
    }
  }
}

const STARTER = `flowchart LR
  A[Idea] --> B{Worth it?}
  B -- yes --> C[Build]
  B -- no --> D[Note it]`

/**
 * A diagram written as text and drawn by Mermaid.
 *
 * The source is the block; the picture is derived every time. Selected, the
 * block shows its source above the drawing so it can be edited in place --
 * there is no separate mode to find.
 */
export const Mermaid = Node.create({
  name: "mermaid",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      code: {
        default: STARTER,
        parseHTML: (element) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [{ tag: "pre[data-type='mermaid']" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    return ["pre", mergeAttributes(HTMLAttributes, { "data-type": "mermaid" }), node.attrs.code]
  },

  // A fenced block: what every Markdown renderer with Mermaid draws.
  renderMarkdown: (node: JSONContent) => {
    const code = ((node.attrs ?? {}) as { code?: string }).code ?? ""
    return "```mermaid\n" + code.replace(/```/g, "` ` `") + "\n```"
  },

  addCommands() {
    return {
      insertMermaid:
        () =>
        ({ chain }) =>
          chain()
            .insertContent([{ type: this.name }, { type: "paragraph" }])
            .run(),
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidView)
  },
})

function MermaidView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const code = node.attrs.code as string
  const { svg, error } = useMermaidSvg(code)
  const [draft, setDraft] = React.useState(code)

  // The source arrives from outside (undo, a reload) as well as from the
  // textarea; keep the draft in step when it does.
  React.useEffect(() => setDraft(code), [code])

  const editing = selected && editor.isEditable

  return (
    <NodeViewWrapper data-drag-handle>
      <div className={cn("ucch-note-card", selected && "ring-ucch-active ring-2")}>
        <div className="ucch-note-card-head">
          <GitBranchIcon className="size-3" /> mermaid
        </div>
        {editing && (
          <Textarea
            value={draft}
            spellCheck={false}
            rows={Math.min(16, Math.max(3, draft.split("\n").length))}
            className="rounded-none border-0 border-b font-mono text-xs"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (draft !== code) updateAttributes({ code: draft })
            }}
            onKeyDown={(event) => event.stopPropagation()}
          />
        )}
        <div className="flex justify-center overflow-x-auto p-3" contentEditable={false}>
          {svg ? (
            <div className="[&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
          ) : (
            !error && <span className="text-muted-foreground text-xs">Rendering…</span>
          )}
        </div>
        {error && (
          <pre className="text-destructive border-t px-3 py-2 text-xs whitespace-pre-wrap">{error}</pre>
        )}
      </div>
    </NodeViewWrapper>
  )
}
