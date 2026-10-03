"use client"

import * as React from "react"
import { mergeAttributes, Node } from "@tiptap/core"
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react"
import { PencilIcon, ShapesIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DRAWIO_ORIGIN,
  drawioEmbedUrl,
  drawioExportMessage,
  drawioLoadMessage,
  parseDrawioMessage,
} from "@/lib/drawio-protocol"
import { deriveTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    drawio: {
      insertDrawio: () => ReturnType
    }
  }
}

/**
 * A diagrams.net diagram.
 *
 * Two attributes: the xml, which is what the editor loads and saves, and an
 * SVG data URL exported alongside it, which is what the page shows. The
 * editor itself runs on diagrams.net in a dialog, so viewing a page never
 * depends on it -- only editing does.
 */
export const Drawio = Node.create({
  name: "drawio",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      xml: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-xml") ?? "",
        renderHTML: (attrs) => ({ "data-xml": attrs.xml }),
      },
      svg: {
        default: null,
        parseHTML: (element) => element.querySelector("img")?.getAttribute("src") ?? null,
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-type='drawio']" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const svg = node.attrs.svg as string | null
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "drawio" }),
      ...(svg ? [["img", { src: svg, alt: "diagram" }] as const] : []),
    ]
  },

  renderMarkdown: () => "<!-- draw.io diagram omitted -->",

  addCommands() {
    return {
      insertDrawio:
        () =>
        ({ chain }) =>
          chain()
            .insertContent([{ type: this.name }, { type: "paragraph" }])
            .run(),
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(DrawioView)
  },
})

function DrawioView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const xml = node.attrs.xml as string
  const svg = node.attrs.svg as string | null
  // A block just inserted has nothing to show, so it opens straight into
  // the editor rather than presenting an empty card to click.
  const [open, setOpen] = React.useState(() => !xml && editor.isEditable)

  return (
    <NodeViewWrapper data-drag-handle>
      <div className={cn("ucch-note-card", selected && "ring-ucch-active ring-2")}>
        <div className="ucch-note-card-head">
          <ShapesIcon className="size-3" /> draw.io
          <span className="flex-1" />
          {editor.isEditable && (
            <Button variant="ghost" size="xs" onClick={() => setOpen(true)}>
              <PencilIcon /> Edit
            </Button>
          )}
        </div>
        <div className="flex justify-center p-3" contentEditable={false}>
          {svg ? (
            <img src={svg} alt="diagram" className="max-w-full" draggable={false} />
          ) : (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground py-6 text-xs"
              onClick={() => setOpen(true)}
            >
              Empty diagram -- click to draw
            </button>
          )}
        </div>
      </div>
      {open && (
        <DrawioDialog
          xml={xml}
          onClose={() => setOpen(false)}
          onSave={(next) => updateAttributes(next)}
        />
      )}
    </NodeViewWrapper>
  )
}

/**
 * The diagrams.net editor in a near-full-screen dialog, speaking the embed
 * protocol: it says `init`, we `load`; it says `save`, we ask for an
 * `export` and keep what comes back; it says `exit`, we close.
 */
function DrawioDialog({
  xml,
  onClose,
  onSave,
}: {
  xml: string
  onClose(): void
  onSave(next: { xml: string; svg: string }): void
}) {
  const frame = React.useRef<HTMLIFrameElement>(null)
  const { theme } = useTheme()
  const dark = deriveTheme(theme).dark
  const latestXml = React.useRef(xml)
  const closeAfterExport = React.useRef(false)
  const [ready, setReady] = React.useState(false)

  React.useEffect(() => {
    const post = (message: string) =>
      frame.current?.contentWindow?.postMessage(message, DRAWIO_ORIGIN)

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      const message = parseDrawioMessage(event.data, event.origin)
      if (!message) return
      switch (message.event) {
        case "init":
          setReady(true)
          post(drawioLoadMessage(latestXml.current))
          break
        case "autosave":
          latestXml.current = message.xml
          break
        case "save":
          latestXml.current = message.xml
          closeAfterExport.current = message.exit
          post(drawioExportMessage(message.xml))
          break
        case "export":
          // Asked for `xmlsvg`, answered as `svg`: the format names the
          // picture, and the data URL is the thing either way.
          if (message.data.startsWith("data:image/svg+xml")) {
            onSave({ xml: message.xml || latestXml.current, svg: message.data })
            if (closeAfterExport.current) onClose()
          }
          break
        case "exit":
          onClose()
          break
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [onClose, onSave])

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex h-[92vh] max-w-[96vw] flex-col gap-0 p-0 sm:max-w-[96vw]"
        showCloseButton
      >
        <DialogTitle className="flex h-9 items-center border-b px-3 text-xs font-medium">
          draw.io {!ready && <span className="text-muted-foreground ml-2">loading…</span>}
        </DialogTitle>
        <iframe
          ref={frame}
          title="draw.io"
          src={drawioEmbedUrl(dark)}
          className="min-h-0 flex-1 rounded-b-lg"
        />
      </DialogContent>
    </Dialog>
  )
}
