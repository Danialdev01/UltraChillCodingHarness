"use client"

import * as React from "react"
import { MinusIcon, PlusIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { cn } from "@/lib/utils"

let counter = 0

/**
 * Mermaid source drawn as SVG, redrawn a beat after the source stops
 * changing so typing does not re-render on every key.
 *
 * Mermaid is imported on first use: it is large, and most pages never draw
 * a diagram. `strict` keeps the source from running script or links. The
 * last good drawing stays up while the source is broken mid-edit.
 */
export function useMermaidSvg(code: string): { svg: string; error: string | null } {
  const dark = useTheme().resolvedMode === "dark"
  const [svg, setSvg] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)
  const idRef = React.useRef(`ucch-mermaid-${++counter}`)

  React.useEffect(() => {
    let cancelled = false
    const handle = setTimeout(async () => {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          fontFamily: "var(--app-font-sans)",
        })
        const result = await mermaid.render(idRef.current, code.trim() || " ")
        if (!cancelled) {
          setSvg(result.svg)
          setError(null)
        }
      } catch (caught) {
        // Mermaid leaves a stray element behind on a parse error.
        document.getElementById(`d${idRef.current}`)?.remove()
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [code, dark])

  return { svg, error }
}

const ZOOM_STEP = 1.25
const ZOOM_MIN = 0.02
const ZOOM_MAX = 8
/** Room left around a fitted drawing, in pixels. */
const FIT_PADDING = 16

type View = { scale: number; x: number; y: number }

/**
 * The drawing at the size Mermaid laid it out at. Mermaid writes
 * `width="100%"` and a `max-width` onto its <svg>, which would size it to
 * whatever holds it; the viewBox is swapped in for both, so the transform
 * alone decides how big it looks.
 */
function sized(svg: string): { html: string; width: number; height: number } | null {
  const open = /<svg\b[^>]*>/.exec(svg)
  const box = open && /viewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/.exec(open[0])
  if (!open || !box) return null
  const width = Number(box[1])
  const height = Number(box[2])
  if (!(width > 0 && height > 0)) return null
  const tag = open[0]
    .replace(/\s(width|height)="[^"]*"/g, "")
    .replace(/\sstyle="[^"]*"/, "")
    .replace(/^<svg\b/, `<svg width="${width}" height="${height}" style="max-width:none"`)
  return { html: svg.replace(open[0], tag), width, height }
}

function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale))
}

/** How far one wheel event zooms. A mouse notch is ~100px; a pinch is a few. */
function wheelFactor(event: WheelEvent): number {
  const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY
  // Browsers report a trackpad pinch as a wheel with ctrlKey and small deltas.
  const speed = event.ctrlKey ? 0.01 : 0.002
  return Math.exp(-pixels * speed)
}

/**
 * The drawing on a pan-and-zoom canvas, with the parse error under it when
 * the source does not parse.
 *
 * Fitted and centred at first. The mouse wheel and a trackpad pinch zoom
 * about the pointer; dragging pans. Once the person has zoomed or panned,
 * a redraw from typing keeps their view; "Fit" brings the whole drawing
 * back. The drawing keeps the size Mermaid laid it out at and is scaled by
 * transform, so zooming never re-lays it out.
 */
export function MermaidPreview({ code, className }: { code: string; className?: string }) {
  const { svg, error } = useMermaidSvg(code)
  const [view, setView] = React.useState<View>({ scale: 1, x: 0, y: 0 })
  // True until the person zooms or pans: a fitted view refits on redraw and resize.
  const [fitted, setFitted] = React.useState(true)
  const pane = React.useRef<HTMLDivElement>(null)
  const drawing = React.useMemo(() => (svg ? sized(svg) : null), [svg])

  const fit = React.useCallback(() => {
    const size = drawing
    const box = pane.current
    if (!size || !box) return
    const width = Math.max(1, box.clientWidth - FIT_PADDING * 2)
    const height = Math.max(1, box.clientHeight - FIT_PADDING * 2)
    // Never blown up past actual size just because the pane is large.
    const scale = clampScale(Math.min(1, width / size.width, height / size.height))
    setView({
      scale,
      x: (box.clientWidth - size.width * scale) / 2,
      y: (box.clientHeight - size.height * scale) / 2,
    })
    setFitted(true)
  }, [drawing])

  // A new drawing refits a view that is still fitted, and keeps one the
  // person has moved. `fitted` is read, not tracked, for exactly that.
  React.useLayoutEffect(() => {
    if (fitted) fit()
  }, [fit])

  React.useEffect(() => {
    const box = pane.current
    if (!box || !fitted) return
    const observer = new ResizeObserver(() => fit())
    observer.observe(box)
    return () => observer.disconnect()
  }, [fitted, fit])

  /** Zooms by `factor`, keeping the point (px, py) of the pane where it is. */
  const zoomAt = React.useCallback((factor: number, px: number, py: number) => {
    setView((current) => {
      const scale = clampScale(current.scale * factor)
      const ratio = scale / current.scale
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
    })
    setFitted(false)
  }, [])

  const zoomAtCentre = (factor: number) => {
    const box = pane.current
    if (box) zoomAt(factor, box.clientWidth / 2, box.clientHeight / 2)
  }

  // Wheel and pinch. Added by hand: React's wheel listener is passive, and
  // the page must not scroll (or the browser zoom) while the drawing does.
  React.useEffect(() => {
    const box = pane.current
    if (!box) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = box.getBoundingClientRect()
      zoomAt(wheelFactor(event), event.clientX - rect.left, event.clientY - rect.top)
    }
    // Safari reports a trackpad pinch as gesture events instead of a wheel.
    let lastScale = 1
    const onGestureStart = (event: Event) => {
      event.preventDefault()
      lastScale = 1
    }
    const onGestureChange = (event: Event) => {
      event.preventDefault()
      const gesture = event as Event & { scale: number; clientX: number; clientY: number }
      const rect = box.getBoundingClientRect()
      zoomAt(gesture.scale / lastScale, gesture.clientX - rect.left, gesture.clientY - rect.top)
      lastScale = gesture.scale
    }
    box.addEventListener("wheel", onWheel, { passive: false })
    box.addEventListener("gesturestart", onGestureStart)
    box.addEventListener("gesturechange", onGestureChange)
    return () => {
      box.removeEventListener("wheel", onWheel)
      box.removeEventListener("gesturestart", onGestureStart)
      box.removeEventListener("gesturechange", onGestureChange)
    }
  }, [zoomAt, svg])

  // Drag to pan.
  const drag = React.useRef<{ id: number; x: number; y: number } | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !svg) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    setDragging(true)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = drag.current
    if (!start || start.id !== event.pointerId) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    drag.current = { id: start.id, x: event.clientX, y: event.clientY }
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }))
    setFitted(false)
  }
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return
    drag.current = null
    setDragging(false)
  }

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div
        ref={pane}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          "relative min-h-0 flex-1 touch-none overflow-hidden select-none",
          svg && (dragging ? "cursor-grabbing" : "cursor-grab"),
        )}
      >
        {svg ? (
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            dangerouslySetInnerHTML={{ __html: drawing?.html ?? svg }}
          />
        ) : (
          !error && <span className="text-muted-foreground block p-4 text-xs">Rendering…</span>
        )}
      </div>
      {svg && (
        <div className="bg-background/90 absolute top-2 right-2 flex items-center gap-0.5 rounded-md border p-0.5 text-xs shadow-sm">
          <button
            type="button"
            title="Zoom out"
            onClick={() => zoomAtCentre(1 / ZOOM_STEP)}
            className="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded"
          >
            <MinusIcon className="size-3.5" />
          </button>
          <button
            type="button"
            title={fitted ? "Actual size" : "Fit to pane"}
            onClick={() => (fitted ? zoomAtCentre(1 / view.scale) : fit())}
            className="text-muted-foreground hover:text-foreground h-6 min-w-10 rounded px-1 tabular-nums"
          >
            {fitted ? "Fit" : `${Math.round(view.scale * 100)}%`}
          </button>
          <button
            type="button"
            title="Zoom in"
            onClick={() => zoomAtCentre(ZOOM_STEP)}
            className="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
      )}
      {error && (
        <pre className="text-destructive max-h-32 shrink-0 overflow-auto border-t px-3 py-2 text-xs whitespace-pre-wrap">
          {error}
        </pre>
      )}
    </div>
  )
}
