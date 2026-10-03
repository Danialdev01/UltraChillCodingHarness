"use client"

import * as React from "react"
import { MinusIcon, PlusIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { deriveTheme } from "@/lib/theme"
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
  const { theme } = useTheme()
  const dark = deriveTheme(theme).dark
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
const ZOOM_MIN = 0.25
const ZOOM_MAX = 4

/**
 * The drawing, with the parse error under it when the source does not parse.
 *
 * Fitted to the pane by default. A large schema fitted is a grey smudge, so
 * the corner has zoom, and the label flips between fit and actual size:
 * past fit, the drawing keeps its size -- the one Mermaid laid it out at,
 * times the zoom -- and the pane scrolls.
 */
export function MermaidPreview({ code, className }: { code: string; className?: string }) {
  const { svg, error } = useMermaidSvg(code)
  const [zoom, setZoom] = React.useState<number | "fit">("fit")
  const holder = React.useRef<HTMLDivElement>(null)
  const pane = React.useRef<HTMLDivElement>(null)

  // Mermaid writes its own width and max-width onto the <svg>; sized here
  // from the viewBox, which is the size it laid the drawing out at.
  React.useLayoutEffect(() => {
    const element = holder.current?.querySelector("svg")
    if (!element) return
    if (zoom === "fit") {
      element.style.width = "100%"
      element.style.maxWidth = "100%"
      element.style.height = "auto"
      return
    }
    const width = element.viewBox.baseVal?.width || element.getBoundingClientRect().width
    element.style.maxWidth = "none"
    element.style.width = `${width * zoom}px`
    element.style.height = "auto"
  }, [svg, zoom])

  const step = (factor: number) =>
    setZoom((current) => {
      const element = holder.current?.querySelector("svg")
      const natural = element?.viewBox.baseVal?.width
      // From fit, start at whatever scale fit was showing.
      const from =
        current === "fit"
          ? natural && pane.current
            ? Math.min(1, pane.current.clientWidth / natural)
            : 1
          : current
      return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, from * factor))
    })

  return (
    <div className={cn("relative flex min-h-0 flex-col", className)}>
      <div ref={pane} className="min-h-0 flex-1 overflow-auto p-4">
        {svg ? (
          <div
            ref={holder}
            className={cn("w-fit min-w-full", zoom === "fit" && "flex justify-center")}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          !error && <span className="text-muted-foreground text-xs">Rendering…</span>
        )}
      </div>
      {svg && (
        <div className="bg-background/90 absolute top-2 right-2 flex items-center gap-0.5 rounded-md border p-0.5 text-xs shadow-sm">
          <button
            type="button"
            title="Zoom out"
            onClick={() => step(1 / ZOOM_STEP)}
            className="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded"
          >
            <MinusIcon className="size-3.5" />
          </button>
          <button
            type="button"
            title={zoom === "fit" ? "Actual size" : "Fit to pane"}
            onClick={() => setZoom((current) => (current === "fit" ? 1 : "fit"))}
            className="text-muted-foreground hover:text-foreground h-6 min-w-10 rounded px-1 tabular-nums"
          >
            {zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`}
          </button>
          <button
            type="button"
            title="Zoom in"
            onClick={() => step(ZOOM_STEP)}
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
