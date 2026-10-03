"use client"

import * as React from "react"
import { mergeAttributes, Node, type JSONContent } from "@tiptap/core"
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react"
import { FileTextIcon } from "lucide-react"

import { useNotes } from "@/components/notes/notes-context"
import { titleOrUntitled } from "@/lib/note-tree"
import { cn } from "@/lib/utils"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageLink: {
      insertPageLink: (attrs: { noteId: string }) => ReturnType
    }
  }
}

/**
 * A page inside a page, Notion's "page" block.
 *
 * The block holds only the id; the title and icon come from the tree at
 * render time, so renaming the page in the sidebar renames every link to
 * it. Deleting the block does not delete the page -- the tree is the
 * record, and a page is deleted there.
 */
export const PageLink = Node.create({
  name: "pageLink",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      noteId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-note-id"),
        renderHTML: (attrs) => ({ "data-note-id": attrs.noteId }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-type='page-link']" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "page-link" })]
  },

  // The block knows only the id; the tree is not in reach here. A link with
  // the page's own scheme is at least something a reader can recognise.
  renderMarkdown: (node: JSONContent) => {
    const noteId = ((node.attrs ?? {}) as { noteId?: string }).noteId
    return noteId ? `[page](ucch-note://${noteId})` : ""
  },

  addCommands() {
    return {
      insertPageLink:
        (attrs) =>
        ({ chain }) =>
          chain()
            .insertContent([{ type: this.name, attrs }, { type: "paragraph" }])
            .run(),
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(PageLinkView)
  },
})

function PageLinkView({ node, selected }: NodeViewProps) {
  const { notes, open } = useNotes()
  const noteId = node.attrs.noteId as string | null
  const page = notes.find((n) => n.id === noteId)

  return (
    <NodeViewWrapper data-drag-handle>
      <button
        type="button"
        onClick={() => page && open(page.id)}
        className={cn(
          "ucch-note-card flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
          page ? "hover:bg-muted cursor-pointer" : "text-muted-foreground cursor-default",
          selected && "ring-ucch-active ring-2",
        )}
        contentEditable={false}
      >
        <span className="w-4 shrink-0 text-center text-[13px] leading-none">
          {page?.icon ?? <FileTextIcon className="text-muted-foreground inline size-4" />}
        </span>
        <span className={cn("truncate", page && "underline decoration-border underline-offset-4")}>
          {page ? titleOrUntitled(page.title) : "Deleted page"}
        </span>
      </button>
    </NodeViewWrapper>
  )
}
