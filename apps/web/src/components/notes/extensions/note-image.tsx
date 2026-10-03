"use client"

import * as React from "react"
import Image from "@tiptap/extension-image"
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react"
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  CaptionsIcon,
  Maximize2Icon,
  Trash2Icon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { snapWidth, widthFromDrag, type ImageAlign } from "@/lib/image-resize"
import { cn } from "@/lib/utils"

/**
 * The image block, with what Notion lets you do to one: drag an edge to
 * size it, put it left, centre or right, give it a caption, open it big.
 *
 * Extends the stock node under the same name, so pages saved before this
 * keep their `image` nodes and `setImage` keeps working. Width is a
 * percentage of the column; the page then reads the same at every size.
 */
export const NoteImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => {
          const value = Number(element.getAttribute("data-width"))
          return Number.isFinite(value) && value > 0 ? value : null
        },
        renderHTML: (attrs) =>
          attrs.width ? { "data-width": attrs.width, style: `width:${attrs.width}%` } : {},
      },
      align: {
        default: "center",
        parseHTML: (element) => element.getAttribute("data-align") ?? "center",
        renderHTML: (attrs) => ({ "data-align": attrs.align }),
      },
      caption: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-caption"),
        renderHTML: (attrs) => (attrs.caption ? { "data-caption": attrs.caption } : {}),
      },
    }
  },

  // `![alt](src "caption")`: the title slot is the one Markdown has for
  // words about a picture.
  renderMarkdown: (node) => {
    const attrs = (node.attrs ?? {}) as { src?: string; alt?: string; caption?: string | null }
    const title = attrs.caption ? ` "${attrs.caption.replace(/"/g, '\\"')}"` : ""
    return `![${attrs.alt ?? ""}](${attrs.src ?? ""}${title})`
  },
  parseMarkdown: (token, helpers) => {
    const t = token as { href?: string; text?: string; title?: string | null }
    return helpers.createNode("image", {
      src: t.href ?? "",
      alt: t.text ?? null,
      caption: t.title ?? null,
    })
  },

  addNodeView() {
    return ReactNodeViewRenderer(NoteImageView)
  },
})

function NoteImageView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const src = node.attrs.src as string
  const alt = (node.attrs.alt as string | null) ?? ""
  const width = node.attrs.width as number | null
  const align = node.attrs.align as ImageAlign
  const caption = node.attrs.caption as string | null

  const wrapper = React.useRef<HTMLDivElement>(null)
  const [dragWidth, setDragWidth] = React.useState<number | null>(null)
  const [captionOpen, setCaptionOpen] = React.useState(caption !== null)
  const [lightbox, setLightbox] = React.useState(false)

  const shown = dragWidth ?? width

  const startResize = (edge: "left" | "right") => (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const figure = wrapper.current
    const column = figure?.parentElement
    if (!figure || !column) return
    const startX = event.clientX
    const startPercent = width ?? (figure.getBoundingClientRect().width / column.clientWidth) * 100
    const containerPx = column.clientWidth
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    let latest = startPercent
    const onMove = (move: PointerEvent) => {
      latest = widthFromDrag({
        startPercent,
        deltaPx: move.clientX - startX,
        containerPx,
        align,
        edge,
      })
      setDragWidth(latest)
    }
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove)
      handle.removeEventListener("pointerup", onUp)
      handle.removeEventListener("pointercancel", onUp)
      setDragWidth(null)
      updateAttributes({ width: snapWidth(latest) })
    }
    handle.addEventListener("pointermove", onMove)
    handle.addEventListener("pointerup", onUp)
    handle.addEventListener("pointercancel", onUp)
  }

  return (
    <NodeViewWrapper
      ref={wrapper}
      className={cn("ucch-note-image group/img", selected && "is-selected")}
      data-align={align}
      style={{ width: shown ? `${shown}%` : undefined }}
    >
      <div className="relative" contentEditable={false}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          data-drag-handle
          draggable
          onDoubleClick={() => setLightbox(true)}
          className={cn(selected && "ring-ucch-active ring-2")}
        />
        <div
          role="separator"
          aria-label="Resize from the left"
          className="ucch-image-handle left-1"
          onPointerDown={startResize("left")}
        />
        <div
          role="separator"
          aria-label="Resize from the right"
          className="ucch-image-handle right-1"
          onPointerDown={startResize("right")}
        />
        {selected && (
          <div className="bg-popover text-popover-foreground absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-md border p-0.5 shadow-md">
            <Tool
              icon={AlignLeftIcon}
              title="Align left"
              active={align === "left"}
              onClick={() => updateAttributes({ align: "left" })}
            />
            <Tool
              icon={AlignCenterIcon}
              title="Align centre"
              active={align === "center"}
              onClick={() => updateAttributes({ align: "center" })}
            />
            <Tool
              icon={AlignRightIcon}
              title="Align right"
              active={align === "right"}
              onClick={() => updateAttributes({ align: "right" })}
            />
            <span className="bg-border mx-0.5 h-4 w-px" />
            {[50, 75, 100].map((percent) => (
              <Button
                key={percent}
                variant="ghost"
                size="xs"
                className={cn("px-1.5 font-mono", width === percent && "bg-muted text-ucch-active")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => updateAttributes({ width: percent === 100 ? null : percent })}
              >
                {percent}%
              </Button>
            ))}
            <span className="bg-border mx-0.5 h-4 w-px" />
            <Tool
              icon={CaptionsIcon}
              title={captionOpen ? "Remove caption" : "Add caption"}
              active={captionOpen}
              onClick={() => {
                if (captionOpen) updateAttributes({ caption: null })
                setCaptionOpen(!captionOpen)
              }}
            />
            <Tool icon={Maximize2Icon} title="Open" onClick={() => setLightbox(true)} />
            <Tool icon={Trash2Icon} title="Delete image" onClick={deleteNode} />
          </div>
        )}
      </div>
      {captionOpen && (
        <input
          defaultValue={caption ?? ""}
          placeholder="Add a caption…"
          aria-label="Caption"
          autoFocus={caption === null}
          className="ucch-image-caption"
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.key === "Enter" || event.key === "Escape") event.currentTarget.blur()
          }}
          onBlur={(event) => {
            const next = event.target.value.trim()
            if (next !== (caption ?? "")) updateAttributes({ caption: next || null })
          }}
        />
      )}
      <Dialog open={lightbox} onOpenChange={setLightbox}>
        <DialogContent className="max-w-[95vw] bg-transparent p-0 ring-0 sm:max-w-[95vw]">
          <DialogTitle className="sr-only">{alt || "Image"}</DialogTitle>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className="mx-auto max-h-[92vh] max-w-full rounded-md object-contain" />
        </DialogContent>
      </Dialog>
    </NodeViewWrapper>
  )
}

function Tool({
  icon: Icon,
  title,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  active?: boolean
  onClick(): void
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={title}
      aria-pressed={active}
      className={cn(active && "bg-muted text-ucch-active")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon />
    </Button>
  )
}
