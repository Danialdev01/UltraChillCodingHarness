"use client"

import * as React from "react"

import type { BrowserTool } from "@/components/browser-toolbar"
import { elementAt } from "@/lib/browser-annotate"
import type { BrowserCapture } from "@/lib/browser-api"
import { drawOp, push, strokeWidths, textSizeFor, toImagePoint, type History, type Op, type Point } from "@/lib/image-annotate"
import { cn } from "@/lib/utils"

/** The marks over the picture, at the page's own size. */
function paint(canvas: HTMLCanvasElement, image: HTMLImageElement, ops: readonly Op[]) {
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext("2d")!
  ctx.drawImage(image, 0, 0)
  for (const op of ops) drawOp(ctx, op)
}

/** Past this a PNG is sent as a JPEG: models refuse very large pictures. */
const MAX_PNG_BYTES = 3_000_000

/** The annotated screenshot as a file for the composer. */
export async function annotatedFile(capture: BrowserCapture, ops: readonly Op[]): Promise<File> {
  const image = new Image()
  image.src = `data:image/png;base64,${capture.image}`
  await image.decode()
  const canvas = document.createElement("canvas")
  paint(canvas, image, ops)
  const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.85))
  let blob = await encode("image/png")
  if (blob && blob.size > MAX_PNG_BYTES) blob = await encode("image/jpeg")
  if (!blob) throw new Error("Could not encode the picture.")
  let host = "page"
  try {
    host = new URL(capture.url).hostname.replace(/[^A-Za-z0-9.-]/g, "") || host
  } catch {}
  return new File([blob], `${host}-annotated.${blob.type === "image/png" ? "png" : "jpg"}`, { type: blob.type })
}

/** A shape being drawn, carried on to `p`. */
function extended(op: Op, p: Point): Op {
  if (op.kind === "stroke") return { ...op, points: [...op.points, p] }
  if (op.kind === "arrow" || op.kind === "rect" || op.kind === "ellipse") return { ...op, to: p }
  return op
}

/** What is being typed: a note on the page, or about a picked element. */
type Typing = { at: Point; value: string; element: number | null }

/**
 * A captured page, to mark up. Its picture does not move under the marks:
 * every element's place was read with it.
 */
export function AnnotationLayer({
  capture,
  tool,
  color,
  widthIndex,
  history,
  onHistory,
}: {
  capture: BrowserCapture
  tool: Exclude<BrowserTool, "live">
  color: string
  widthIndex: "0" | "1" | "2"
  history: History
  onHistory: (update: (history: History) => History) => void
}) {
  const frameRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const [image, setImage] = React.useState<HTMLImageElement | null>(null)
  const [draft, showDraft] = React.useState<Op | null>(null)
  // The stroke being drawn, ahead of its render: a fast release must not commit an older one.
  const drawing = React.useRef<Op | null>(null)
  const setDraft = (op: Op | null) => {
    drawing.current = op
    showDraft(op)
  }
  const [hovered, setHovered] = React.useState(-1)
  const [typing, setTyping] = React.useState<Typing | null>(null)
  const [scale, setScale] = React.useState(0)
  const { width, height } = capture.viewport
  const stroke = strokeWidths(width, height)[Number(widthIndex)]!

  React.useEffect(() => {
    let live = true
    const next = new Image()
    next.onload = () => live && setImage(next)
    next.src = `data:image/png;base64,${capture.image}`
    return () => {
      live = false
    }
  }, [capture])

  // Fitted by hand: the label inputs are placed over the picture, so its box has to be the picture's.
  React.useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const fit = () => setScale(Math.min(1, frame.clientWidth / width, frame.clientHeight / height))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [width, height])

  React.useEffect(() => {
    if (canvasRef.current && image) paint(canvasRef.current, image, draft ? [...history.ops, draft] : history.ops)
  }, [image, history, draft])

  function commit() {
    if (!typing) return
    const note = typing.value.trim()
    const { element, at } = typing
    if (element !== null) {
      const rect = capture.elements[element]!.rect
      onHistory((h) =>
        push(h, { kind: "pin", rect, n: h.ops.filter((op) => op.kind === "pin").length + 1, note, element, color, width: stroke }),
      )
    } else if (note) {
      onHistory((h) => push(h, { kind: "text", at, text: note, color, size: textSizeFor(stroke) }))
    }
    setTyping(null)
  }

  const pointOf = (event: React.PointerEvent): Point => {
    const p = toImagePoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), { x: 0, y: 0, w: width, h: height })
    return { x: Math.max(0, Math.min(width, p.x)), y: Math.max(0, Math.min(height, p.y)) }
  }

  const outlined = typing?.element ?? (tool === "element" ? hovered : -1)
  const outline = outlined >= 0 ? capture.elements[outlined] : undefined

  return (
    <div ref={frameRef} className="flex size-full min-h-0 min-w-0 items-center justify-center">
      <div className="relative shrink-0" style={{ width: width * scale, height: height * scale }}>
        <canvas
          ref={canvasRef}
          aria-label="The captured page, to mark up"
          className={cn("block size-full touch-none rounded-md shadow-sm", tool === "element" ? "cursor-pointer" : tool === "text" ? "cursor-text" : "cursor-crosshair")}
          onPointerDown={(event) => {
            if (!image || event.button !== 0 || typing || tool === "element" || tool === "text") return
            event.currentTarget.setPointerCapture(event.pointerId)
            const p = pointOf(event)
            setDraft(
              tool === "pen"
                ? { kind: "stroke", points: [p], color, width: stroke }
                : { kind: tool, from: p, to: p, color, width: stroke },
            )
          }}
          onPointerMove={(event) => {
            const p = pointOf(event)
            if (tool === "element" && !typing) setHovered(elementAt(capture.elements, p))
            if (drawing.current) setDraft(extended(drawing.current, p))
          }}
          onPointerLeave={() => setHovered(-1)}
          onPointerCancel={() => setDraft(null)}
          onPointerUp={(event) => {
            if (!image || event.button !== 0) return
            const p = pointOf(event)
            // On release: the press's own focus change would blur the input as it appeared.
            if (tool === "element" || tool === "text") {
              if (typing) return
              const element = tool === "element" ? elementAt(capture.elements, p) : null
              if (element !== -1) setTyping({ at: p, value: "", element })
              return
            }
            if (!drawing.current) return
            const d = extended(drawing.current, p)
            setDraft(null)
            if ("from" in d && Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 3) return
            onHistory((h) => push(h, d))
          }}
        />
        {outline && (
          <div
            aria-hidden
            className="border-primary bg-primary/15 pointer-events-none absolute border-2"
            style={{ left: outline.rect.x * scale, top: outline.rect.y * scale, width: outline.rect.w * scale, height: outline.rect.h * scale }}
          >
            <span
              className={cn(
                "bg-primary text-primary-foreground absolute left-0 max-w-72 truncate rounded-sm px-1 text-2xs whitespace-nowrap",
                outline.rect.y * scale > 20 ? "-top-5" : "top-0",
              )}
            >
              {outline.tag} · {outline.rect.w}×{outline.rect.h}
            </span>
          </div>
        )}
        {typing && (
          <input
            autoFocus
            value={typing.value}
            aria-label={typing.element === null ? "Note" : "Note about this element"}
            placeholder={typing.element === null ? "Note, then Enter" : "What should change? Enter to pin"}
            maxLength={1000}
            onChange={(e) => setTyping({ ...typing, value: e.target.value })}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                commit()
              } else if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                setTyping(null)
              }
            }}
            style={{
              left: Math.max(0, Math.min(typing.at.x * scale, width * scale - 256)),
              top: Math.max(0, Math.min(typing.at.y * scale, height * scale - 32)),
            }}
            className="bg-popover text-popover-foreground border-ring absolute h-8 w-64 max-w-full rounded-md border px-2 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        )}
      </div>
    </div>
  )
}
