"use client"

import * as React from "react"
import { mergeAttributes, Node, type JSONContent } from "@tiptap/core"
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react"
import { ExternalLinkIcon, GlobeIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { classifyEmbedUrl, type EmbedProvider } from "@/lib/embed-url"
import { containerOpen } from "@/lib/markdown-containers"
import { cn } from "@/lib/utils"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    embed: {
      insertEmbed: (url?: string) => ReturnType
    }
  }
}

/**
 * A page from elsewhere, framed: a video, a design, a pen, a site.
 *
 * The block keeps the link as pasted and the frame URL derived from it,
 * so the derivation can change without touching saved pages. A block with
 * no link yet shows a field for one, which is how the slash command
 * inserts it.
 */
export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-src") ?? "",
        renderHTML: (attrs) => ({ "data-src": attrs.src }),
      },
      original: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-original") ?? "",
        renderHTML: (attrs) => ({ "data-original": attrs.original }),
      },
      provider: {
        default: "generic",
        parseHTML: (element) => element.getAttribute("data-provider") ?? "generic",
        renderHTML: (attrs) => ({ "data-provider": attrs.provider }),
      },
      height: {
        default: 400,
        parseHTML: (element) => Number(element.getAttribute("data-height")) || 400,
        renderHTML: (attrs) => ({ "data-height": attrs.height }),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-type='embed']" }]
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "embed" })]
  },

  // One line of HTML, which the importer maps back through `parseHTML`;
  // the link after it is what a reader elsewhere can click.
  renderMarkdown: (node: JSONContent) => {
    const attrs = (node.attrs ?? {}) as { src?: string; original?: string; provider?: string }
    if (!attrs.original) return ""
    return `${containerOpen("div", {
      "data-type": "embed",
      "data-src": attrs.src,
      "data-original": attrs.original,
      "data-provider": attrs.provider,
    })}</div>`
  },

  addCommands() {
    return {
      insertEmbed:
        (url) =>
        ({ chain }) => {
          const target = url ? classifyEmbedUrl(url) : null
          if (url && !target) return false
          return chain()
            .insertContent([
              {
                type: this.name,
                attrs: target
                  ? { src: target.src, original: target.original, provider: target.provider }
                  : {},
              },
              { type: "paragraph" },
            ])
            .run()
        },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(EmbedView)
  },
})

function EmbedView({ node, updateAttributes, selected }: NodeViewProps) {
  const src = node.attrs.src as string
  const original = node.attrs.original as string
  const provider = node.attrs.provider as EmbedProvider
  const height = node.attrs.height as number
  const [draft, setDraft] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const video = provider === "youtube" || provider === "vimeo" || provider === "loom"

  return (
    <NodeViewWrapper data-drag-handle>
      <div className={cn("ucch-note-card", selected && "ring-ucch-active ring-2")}>
        <div className="ucch-note-card-head">
          <GlobeIcon className="size-3" />
          <span className="min-w-0 flex-1 truncate">{original || "embed"}</span>
          {original && (
            <a
              href={original}
              target="_blank"
              rel="noreferrer noopener"
              title="Open in a new tab"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </div>
        {src ? (
          <div
            className={cn("relative w-full bg-black/5", video && "aspect-video")}
            style={video ? undefined : { height }}
            contentEditable={false}
          >
            <iframe
              src={src}
              title={original}
              loading="lazy"
              sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms"
              allow="fullscreen; picture-in-picture; clipboard-write"
              referrerPolicy="strict-origin-when-cross-origin"
              className="absolute inset-0 size-full border-0"
            />
          </div>
        ) : (
          <form
            className="flex items-center gap-2 p-3"
            contentEditable={false}
            onSubmit={(event) => {
              event.preventDefault()
              const target = classifyEmbedUrl(draft)
              if (!target) {
                setError("Paste a full https:// link.")
                return
              }
              updateAttributes({ src: target.src, original: target.original, provider: target.provider })
            }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder="Paste a link to a video, a design, a page…"
              aria-label="Link to embed"
              className="bg-background h-7 min-w-0 flex-1 rounded border px-2 text-xs outline-none"
            />
            <Button type="submit" size="xs" variant="secondary">
              Embed
            </Button>
            {error && <span className="text-destructive text-xs">{error}</span>}
          </form>
        )}
      </div>
    </NodeViewWrapper>
  )
}
