"use client"

import * as React from "react"
import { MaximizeIcon, MinusIcon, PlusIcon, ScanIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  clampView,
  distance,
  DOUBLE_CLICK_SCALE,
  fitView,
  isPannable,
  midpoint,
  normalizeWheelDelta,
  STEP_IN,
  STEP_OUT,
  wheelZoomFactor,
  zoomClamped,
  type Point,
  type Size,
  type View,
} from "@/lib/zoom"

/**
 * A pannable, zoomable image.
 *
 * Four ways in, because they are four different machines: `+` and `-` on a
 * keyboard, a mouse wheel, a trackpad pinch, and two fingers on a phone. The
 * arithmetic they all funnel into lives in `lib/zoom.ts`; what is here is the
 * event plumbing, which has three parts worth knowing about.
 *
 * **The wheel listener is attached by hand.** React registers `wheel` at the
 * root as a passive listener, so `preventDefault()` inside an `onWheel` prop
 * silently does nothing and the page scrolls while the image zooms. The only
 * fix is `addEventListener` with `{ passive: false }` on the element itself.
 *
 * **A trackpad pinch is a wheel event with `ctrlKey`.** There is no separate
 * gesture event on anything but Safari; every browser reports a two-finger
 * trackpad pinch this way. Ctrl+wheel from a real mouse is indistinguishable,
 * and should zoom too, so nothing tries to tell them apart.
 *
 * **Touch is handled through Pointer Events, not touch events.** One code
 * path covers mouse, pen and finger, and `setPointerCapture` keeps a drag
 * alive when the pointer leaves the element. `touch-action: none` is what
 * makes it work on a phone: without it the browser claims the gesture for
 * page scrolling and pinch-zoom, and the events stop arriving mid-drag.
 */
export function ImageViewer({
  src,
  alt,
  raster,
  onLoad,
  onError,
}: {
  src: string
  alt: string
  /** False for SVG, which is drawn from vectors and must never be pixelated. */
  raster: boolean
  onLoad: () => void
  onError: () => void
}) {
  const frame = React.useRef<HTMLDivElement>(null)
  const [content, setContent] = React.useState<Size | null>(null)
  const [viewport, setViewport] = React.useState<Size>({ width: 0, height: 0 })
  const [view, setView] = React.useState<View>({ scale: 1, x: 0, y: 0 })

  // Both sizes are needed for every calculation, and both arrive
  // asynchronously -- the pane from a resize observation, the image from its
  // own load event. A ref as well as state because the event handlers below
  // are attached once and would otherwise close over the first value.
  const geometry = React.useRef({ content, viewport, view })
  geometry.current = { content, viewport, view }

  /** Applies a change written in terms of the current geometry. */
  const update = React.useCallback((next: (g: { content: Size; viewport: Size; view: View }) => View) => {
    const { content: c, viewport: v, view: current } = geometry.current
    if (!c || v.width === 0) return
    setView(next({ content: c, viewport: v, view: current }))
  }, [])

  /** Back to the whole image, centred. Also the state it opens in. */
  const reset = React.useCallback(() => {
    const { content: c, viewport: v } = geometry.current
    if (c && v.width > 0) setView(fitView(c, v))
  }, [])

  /** Zoom by a factor about a point, defaulting to the middle of the pane. */
  const zoomBy = React.useCallback(
    (factor: number, focal?: Point) => {
      update(({ content: c, viewport: v, view: current }) =>
        zoomClamped(current, focal ?? { x: v.width / 2, y: v.height / 2 }, factor, c, v),
      )
    },
    [update],
  )

  // The pane's size, watched rather than measured once: the file panel is
  // resizable and the window is not fixed, and a stale viewport would clamp
  // the image against an edge that has moved.
  React.useEffect(() => {
    const element = frame.current
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect
      setViewport({ width: box.width, height: box.height })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Fit whenever the file or the pane changes shape. Not on every view
  // change, which would undo the reader's zoom the moment they made it.
  React.useEffect(() => {
    if (content && viewport.width > 0) setView(fitView(content, viewport))
  }, [content, viewport])

  // A new file in the same tab strip reuses this component; without this the
  // next image would inherit the last one's zoom and offset.
  React.useEffect(() => setContent(null), [src])

  /**
   * Wheel and trackpad pinch.
   *
   * Attached here rather than as an `onWheel` prop so it can be non-passive
   * -- see the note at the top. Re-registered on nothing, because it reads
   * geometry from the ref rather than from a closure.
   */
  React.useEffect(() => {
    const element = frame.current
    if (!element) return

    function onWheel(event: WheelEvent) {
      const box = element!.getBoundingClientRect()
      // Without this the pane, or the page behind it, scrolls at the same
      // time as the image zooms.
      event.preventDefault()

      const delta = normalizeWheelDelta(event.deltaY, event.deltaMode)
      const focal = { x: event.clientX - box.left, y: event.clientY - box.top }
      update(({ content: c, viewport: v, view: current }) =>
        zoomClamped(current, focal, wheelZoomFactor(delta, event.ctrlKey), c, v),
      )
    }

    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [update])

  /**
   * Every pointer currently down, by id.
   *
   * One is a drag; two are a pinch. Keeping them in a map rather than in
   * state is deliberate -- they change on every `pointermove`, and rendering
   * for each one would drop frames on a phone for no visible benefit.
   */
  const pointers = React.useRef(new Map<number, Point>())
  /** What the gesture started from, so a pinch scales from where it began. */
  const gesture = React.useRef<{ distance: number; focal: Point; view: View } | null>(null)

  const positionIn = (event: React.PointerEvent): Point => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  /**
   * Takes the pinch's measurements from wherever the fingers are now.
   *
   * Called whenever the set of pointers changes, not only when the second
   * one lands: putting a third finger down or lifting one back to two has to
   * restart the gesture from the current spread, or the image jumps by
   * however far the previous pinch had travelled.
   */
  const rebase = React.useCallback(() => {
    const active = [...pointers.current.values()]
    gesture.current =
      active.length === 2
        ? {
            distance: distance(active[0]!, active[1]!),
            focal: midpoint(active[0]!, active[1]!),
            view: geometry.current.view,
          }
        : null
  }, [])

  function onPointerDown(event: React.PointerEvent) {
    // The capture is what keeps a drag going when the pointer leaves the
    // pane, and what guarantees the matching `pointerup` arrives here.
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, positionIn(event))
    rebase()
  }

  function onPointerMove(event: React.PointerEvent) {
    if (!pointers.current.has(event.pointerId)) return
    const previous = pointers.current.get(event.pointerId)!
    const position = positionIn(event)
    pointers.current.set(event.pointerId, position)

    const active = [...pointers.current.values()]

    if (active.length >= 2 && gesture.current) {
      // Pinch: the ratio of the fingers' separation is the scale, and their
      // midpoint is both the focal point and a pan -- which is what makes a
      // two-finger gesture feel like moving a photograph rather than
      // operating a zoom control.
      const spread = distance(active[0]!, active[1]!)
      if (gesture.current.distance <= 0) return
      const centre = midpoint(active[0]!, active[1]!)
      const start = gesture.current

      update(({ content: c, viewport: v }) => {
        const zoomed = zoomClamped(
          start.view,
          start.focal,
          spread / start.distance,
          c,
          v,
        )
        return clampView(
          {
            scale: zoomed.scale,
            x: zoomed.x + (centre.x - start.focal.x),
            y: zoomed.y + (centre.y - start.focal.y),
          },
          c,
          v,
        )
      })
      return
    }

    // Drag. Buttons are checked so a mouse moving across the pane with
    // nothing held down does not pan it.
    if (event.pointerType !== "touch" && event.buttons === 0) return
    const dx = position.x - previous.x
    const dy = position.y - previous.y
    update(({ content: c, viewport: v, view: current }) =>
      clampView({ scale: current.scale, x: current.x + dx, y: current.y + dy }, c, v),
    )
  }

  function onPointerUp(event: React.PointerEvent) {
    pointers.current.delete(event.pointerId)
    // Two fingers left means the pinch continues from where they are; one
    // means it becomes a drag, and the remaining finger must not carry the
    // pinch's baseline into it.
    rebase()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const fitted = content ? fitView(content, viewport).scale : 1
  const pannable = content ? isPannable(view, content, viewport) : false
  const atFit = Math.abs(view.scale - fitted) < 0.001

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={frame}
        // Focusable so the keyboard shortcuts have somewhere to land, and
        // labelled so what it is is not left to the image alone.
        tabIndex={0}
        role="img"
        aria-label={`${alt} — zoom ${Math.round(view.scale * 100)}%`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          const focal = { x: event.clientX - box.left, y: event.clientY - box.top }
          // A double-click is "show me this bit closer", and a second one is
          // "put it back" -- so it toggles rather than zooming without end.
          if (atFit) zoomBy(DOUBLE_CLICK_SCALE / view.scale, focal)
          else reset()
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 16
          const pan = (dx: number, dy: number) =>
            update(({ content: c, viewport: v, view: current }) =>
              clampView({ scale: current.scale, x: current.x + dx, y: current.y + dy }, c, v),
            )

          switch (event.key) {
            // `=` is the unshifted key on the same cap as `+`, and is what
            // gets pressed in practice.
            case "+":
            case "=":
              zoomBy(STEP_IN)
              break
            case "-":
            case "_":
              zoomBy(STEP_OUT)
              break
            case "0":
              reset()
              break
            case "1":
              zoomBy(1 / view.scale)
              break
            case "ArrowLeft":
              pan(step, 0)
              break
            case "ArrowRight":
              pan(-step, 0)
              break
            case "ArrowUp":
              pan(0, step)
              break
            case "ArrowDown":
              pan(0, -step)
              break
            default:
              return
          }
          // Only for keys actually handled: the panel's own shortcuts, and
          // the browser's, still work for everything else.
          event.preventDefault()
        }}
        className="focus-visible:ring-ring min-h-0 flex-1 overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-inset"
        style={{
          // The browser must not claim the gesture for scrolling or its own
          // page zoom, or the pointer events stop arriving mid-drag. This one
          // declaration is what makes the phone case work at all.
          touchAction: "none",
          cursor: pannable ? "grab" : "default",
        }}
      >
        <div
          style={{
            // Origin at the top left so the transform is exactly the model
            // the arithmetic assumes; a centred origin would put half the
            // content size into every equation.
            transformOrigin: "0 0",
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            width: content?.width,
            height: content?.height,
            willChange: "transform",
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- the point
              is the raw element: next/image would proxy and re-encode a file
              from the user's own workspace, and cannot help with an SVG. */}
          <img
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget
              setContent({
                // `naturalWidth` is 0 for an SVG with no intrinsic size; the
                // laid-out box is the honest fallback, and 300x150 is what
                // the browser gives such a file anyway.
                width: image.naturalWidth || image.width || 300,
                height: image.naturalHeight || image.height || 150,
              })
              onLoad()
            }}
            onError={onError}
            className="block h-full w-full select-none"
            style={{
              // Past a few times actual size, smoothing is a lie about what
              // is in the file -- and inspecting exact pixels is most of why
              // anyone zooms an asset this far. Never for SVG, which has no
              // pixels to show and re-renders sharp at any scale.
              imageRendering: raster && view.scale >= 3 ? "pixelated" : "auto",
              // The checkerboard rides with the image rather than sitting
              // behind the pane, so a transparent PNG reads as transparent
              // and the squares do not slide about underneath it.
              backgroundImage:
                "repeating-conic-gradient(color-mix(in oklch, var(--muted-foreground) 18%, transparent) 0% 25%, transparent 0% 50%)",
              backgroundSize: `${16 / view.scale}px ${16 / view.scale}px`,
            }}
          />
        </div>
      </div>

      {/* Over the image rather than above it: the pane is short, and a
          toolbar row would come out of the picture's height. */}
      <div className="bg-background/85 absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border p-1 shadow-sm backdrop-blur-sm">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => zoomBy(STEP_OUT)}
          title="Zoom out (-)"
        >
          <MinusIcon className="size-3.5" />
          <span className="sr-only">Zoom out</span>
        </Button>

        {/* The readout is also the 1:1 button -- the two belong to the same
            thought, and a row of four separate controls does not fit. */}
        <button
          type="button"
          onClick={() => zoomBy(1 / view.scale)}
          title="Actual size (1)"
          className="hover:text-foreground text-muted-foreground min-w-14 px-1 text-center font-mono text-xs tabular-nums"
        >
          {Math.round(view.scale * 100)}%
        </button>

        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => zoomBy(STEP_IN)}
          title="Zoom in (+)"
        >
          <PlusIcon className="size-3.5" />
          <span className="sr-only">Zoom in</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={reset}
          title="Fit to window (0)"
          disabled={atFit}
        >
          {atFit ? <ScanIcon className="size-3.5" /> : <MaximizeIcon className="size-3.5" />}
          <span className="sr-only">Fit to window</span>
        </Button>

        {content && (
          <span className="text-muted-foreground border-l pr-1 pl-2 font-mono text-[10px] tabular-nums">
            {content.width}×{content.height}
          </span>
        )}
      </div>
    </div>
  )
}
