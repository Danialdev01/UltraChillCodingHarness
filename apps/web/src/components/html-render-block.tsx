"use client"

import * as React from "react"
import { CheckIcon, CodeIcon, CopyIcon, EyeIcon, RotateCwIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { copyText } from "@/lib/clipboard"
import {
  HTML_RENDER_DEFAULT_HEIGHT,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_TOKENS,
  buildHtmlRenderDocument,
  htmlRenderTitle,
  readLinkMessage,
  readSizeMessage,
  themeMessage,
  type HtmlRenderTheme,
} from "@/lib/html-render"

/** The app's tokens as they stand on <html> right now, palette overrides included. */
function readTheme(mode: "light" | "dark"): HtmlRenderTheme {
  const style = getComputedStyle(document.documentElement)
  const variables: Record<string, string> = {}
  for (const name of HTML_RENDER_TOKENS) {
    const value = style.getPropertyValue(name).trim()
    if (value) variables[name] = value
  }
  return { mode, variables }
}

/**
 * A ```html-render fence, run as a page. See `lib/html-render.ts` for what
 * the frame may and may not do.
 *
 * The document is built once per source: a theme change is posted into the
 * running page rather than rebuilding `srcdoc`, which would reload it and
 * throw away whatever the reader had done in it.
 */
export function HtmlRenderBlock({ source }: { source: string }) {
  const mode: "light" | "dark" = useTheme().resolvedMode === "dark" ? "dark" : "light"
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const [view, setView] = React.useState<"preview" | "code">("preview")
  const [height, setHeight] = React.useState(HTML_RENDER_DEFAULT_HEIGHT)
  const [generation, setGeneration] = React.useState(0)
  const [copied, setCopied] = React.useState(false)

  // Built on the client only: the theme is read off the live document.
  const [srcDoc, setSrcDoc] = React.useState<string | null>(null)
  const modeRef = React.useRef(mode)
  modeRef.current = mode
  React.useEffect(() => {
    setSrcDoc(buildHtmlRenderDocument(source, readTheme(modeRef.current)))
  }, [source, generation])

  React.useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(themeMessage(readTheme(mode)), "*")
  }, [mode])

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      const size = readSizeMessage(event.data)
      if (size !== undefined) {
        setHeight(size)
        return
      }
      const url = readLinkMessage(event.data)
      // Only while the reader is actually using the frame, so a page cannot
      // open tabs on its own.
      if (url && document.activeElement === frame) window.open(url, "_blank", "noopener,noreferrer")
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const title = htmlRenderTitle(source)
  const button =
    "hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded px-1 py-0.5 outline-none focus-visible:ring-1"

  return (
    <div className="my-2 overflow-hidden rounded-md border" data-testid="html-render">
      <div className="text-muted-foreground bg-muted/60 flex h-7 items-center gap-2 border-b px-2 text-[10px]">
        <span className="truncate font-mono">{title ?? "html"}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className={button}
            onClick={() => setView(view === "preview" ? "code" : "preview")}
            aria-pressed={view === "code"}
          >
            {view === "preview" ? <CodeIcon className="size-3" /> : <EyeIcon className="size-3" />}
            {view === "preview" ? "Code" : "Preview"}
          </button>
          {view === "preview" && (
            <button
              type="button"
              className={button}
              onClick={() => {
                setHeight(HTML_RENDER_DEFAULT_HEIGHT)
                setGeneration((n) => n + 1)
              }}
              aria-label="Reload"
            >
              <RotateCwIcon className="size-3" />
            </button>
          )}
          <button
            type="button"
            className={button}
            onClick={() => void copyText(source).then((ok) => ok && setCopied(true))}
          >
            {copied ? <CheckIcon className="text-ucch-active size-3" /> : <CopyIcon className="size-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {view === "code" ? (
        <pre className="bg-muted/60 max-h-64 overflow-auto p-3 text-xs @md:max-h-96">
          <code className="font-mono text-xs">{source}</code>
        </pre>
      ) : srcDoc === null ? (
        <div className="bg-muted/40 animate-pulse" style={{ height }} />
      ) : (
        <iframe
          // A fresh element per reload, so the page starts from nothing.
          key={generation}
          ref={frameRef}
          title={title ?? "HTML preview"}
          srcDoc={srcDoc}
          // Scripts only: no same-origin (so no cookies, storage or DOM of
          // this app), no top navigation, no forms, no popups of its own.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="block w-full border-0 bg-transparent"
          style={{ height, maxHeight: HTML_RENDER_MAX_HEIGHT }}
        />
      )}
    </div>
  )
}
