"use client"

import * as React from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  CodeIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  Maximize2Icon,
  RotateCwIcon,
  SparklesIcon,
} from "lucide-react"
import {
  humaniseWidgetTitle,
  widgetFileName,
  widgetFromToolUse,
  widgetId,
  type Widget,
} from "@ucch/protocol/plain"

import { useTheme } from "@/components/theme-provider"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { copyText } from "@/lib/clipboard"
import {
  WIDGET_DEFAULT_HEIGHT,
  WIDGET_MAX_HEIGHT,
  WIDGET_MIN_HEIGHT,
  WIDGET_SANDBOX,
  WIDGET_TOKENS,
  buildWidgetDocument,
  documentTitle,
  fixPrompt,
  inlineHeight,
  readWidgetMessage,
  standaloneWidgetHtml,
  themeMessage,
  type WidgetTheme,
} from "@/lib/widget-frame"
import { useWidgetHost } from "@/lib/widget-host"
import { useWidgetPromptMode } from "@/lib/widget-prompt-mode"

/** The app's tokens as they stand on <html> right now, palette overrides included. */
function readTheme(mode: "light" | "dark"): WidgetTheme {
  const style = getComputedStyle(document.documentElement)
  const variables: Record<string, string> = {}
  for (const name of WIDGET_TOKENS) {
    const value = style.getPropertyValue(name).trim()
    if (value) variables[name] = value
  }
  return { mode, variables }
}

function useThemeMode(): "light" | "dark" {
  return useTheme().resolvedMode === "dark" ? "dark" : "light"
}

/**
 * Last reported height per widget, so a frame mounted again for the same
 * code -- the answer moving from streaming to settled, a thread reopened --
 * starts at its size instead of jumping.
 */
const knownHeights = new Map<string, number>()

const BUTTON =
  "hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded px-1 py-0.5 outline-none focus-visible:ring-1"

/**
 * One sandboxed frame running a widget. Built once per code: a theme change
 * is posted into the running page rather than rebuilding `srcdoc`, which
 * would reload it and throw away whatever the reader had done in it.
 */
function WidgetIframe({
  widget,
  id,
  title,
  fill,
  onHeight,
  onError,
  onPrompt,
}: {
  widget: Widget
  id: string
  title: string
  /** Fullscreen: fill the container, no height cap. */
  fill?: boolean
  onHeight?: (height: number) => void
  onError: (message: string) => void
  onPrompt: (text: string) => void
}) {
  const mode = useThemeMode()
  const frameRef = React.useRef<HTMLIFrameElement>(null)
  const modeRef = React.useRef(mode)
  modeRef.current = mode

  // Built on the client only: the theme is read off the live document.
  // Keyed on the code, not the object: a parent re-parsing the same fence
  // hands a new object each render, and that must not reload the page.
  const { code, kind } = widget
  const [srcDoc, setSrcDoc] = React.useState<string | null>(null)
  React.useEffect(() => {
    setSrcDoc(buildWidgetDocument({ code, kind }, readTheme(modeRef.current), id))
  }, [code, kind, id])

  React.useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(themeMessage(readTheme(mode)), "*")
  }, [mode])

  const handlers = React.useRef({ onHeight, onError, onPrompt })
  handlers.current = { onHeight, onError, onPrompt }

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current
      // The frame's own window, and its own id: another widget, or anything
      // else posting to this window, is not this one.
      if (!frame || event.source !== frame.contentWindow) return
      const message = readWidgetMessage(event.data, id)
      if (!message) return
      switch (message.type) {
        case "resize":
          handlers.current.onHeight?.(message.height)
          return
        case "error":
          handlers.current.onError(message.message)
          return
        case "prompt":
          // Only while the reader is using the frame, so a page cannot type
          // into the composer on its own.
          if (document.activeElement === frame) handlers.current.onPrompt(message.text)
          return
        case "link":
          if (document.activeElement === frame) window.open(message.url, "_blank", "noopener,noreferrer")
          return
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [id])

  if (srcDoc === null) return <div className="bg-muted/40 h-full min-h-30 animate-pulse" />
  return (
    <iframe
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      // Scripts only: no same-origin (so no cookies, storage or DOM of this
      // app), no top navigation, no forms, no popups. Never widen this.
      sandbox={WIDGET_SANDBOX}
      referrerPolicy="no-referrer"
      loading="lazy"
      className={fill ? "block h-full w-full border-0 bg-transparent" : "block w-full border-0 bg-transparent"}
    />
  )
}

/**
 * A widget in an answer: the frame, sized to its content, with a toolbar --
 * expand, code, copy, download, reload -- and an error bar when the page
 * throws. See `lib/widget-frame.ts` for what the frame may and may not do.
 */
export const WidgetFrame = React.memo(
  function WidgetFrame({ widget }: { widget: Widget }) {
    const host = useWidgetHost()
    const promptMode = useWidgetPromptMode()
    const mode = useThemeMode()
    const id = React.useMemo(() => widgetId(widget.code), [widget.code])
    const title = humaniseWidgetTitle(widget.title ?? documentTitle(widget.code))

    const [view, setView] = React.useState<"preview" | "code">("preview")
    const [content, setContent] = React.useState(
      () => knownHeights.get(id) ?? widget.height ?? WIDGET_DEFAULT_HEIGHT,
    )
    const [generation, setGeneration] = React.useState(0)
    const [copied, setCopied] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [expanded, setExpanded] = React.useState(false)

    React.useEffect(() => {
      if (!copied) return
      const timer = setTimeout(() => setCopied(false), 2000)
      return () => clearTimeout(timer)
    }, [copied])

    const onHeight = React.useCallback(
      (height: number) => {
        knownHeights.set(id, height)
        setContent(height)
      },
      [id],
    )
    // The first error is the one worth fixing; later ones usually follow from it.
    const onError = React.useCallback((message: string) => setError((current) => current ?? message), [])
    const onPrompt = React.useCallback(
      (text: string) => {
        if (promptMode === "send" && host.send) host.send(text)
        else host.insert?.(text)
      },
      [promptMode, host],
    )

    function reload() {
      setError(null)
      setGeneration((n) => n + 1)
    }

    function download() {
      const html = standaloneWidgetHtml(widget, readTheme(mode))
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }))
      const a = document.createElement("a")
      a.href = url
      a.download = widgetFileName(widget.title ?? title)
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    const height = inlineHeight(content)
    const scrolls = content > WIDGET_MAX_HEIGHT

    // No card around it: the page sits in the answer like the prose does,
    // and its actions float over the top-right corner on hover or focus
    // (always on touch screens, which cannot hover).
    return (
      <div className="group/widget relative my-2" data-testid="widget" role="group" aria-label={title}>
        <div
          className={
            "text-muted-foreground bg-background/90 absolute top-1 right-1 z-10 flex items-center gap-1 rounded-md border px-1 py-0.5 text-[10px] shadow-sm backdrop-blur " +
            (view === "code"
              ? "opacity-100"
              : "opacity-0 transition-opacity group-focus-within/widget:opacity-100 group-hover/widget:opacity-100 [@media(hover:none)]:opacity-100")
          }
        >
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={BUTTON}
              onClick={() => setView(view === "preview" ? "code" : "preview")}
              aria-pressed={view === "code"}
            >
              {view === "preview" ? <CodeIcon className="size-3" /> : <EyeIcon className="size-3" />}
              {view === "preview" ? "Code" : "Preview"}
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => void copyText(widget.code).then((ok) => ok && setCopied(true))}
              aria-label="Copy code"
            >
              {copied ? <CheckIcon className="text-ucch-active size-3" /> : <CopyIcon className="size-3" />}
            </button>
            <button type="button" className={BUTTON} onClick={download} aria-label="Download .html">
              <DownloadIcon className="size-3" />
            </button>
            {view === "preview" && (
              <button type="button" className={BUTTON} onClick={reload} aria-label="Reload">
                <RotateCwIcon className="size-3" />
              </button>
            )}
            <button type="button" className={BUTTON} onClick={() => setExpanded(true)} aria-label="Expand">
              <Maximize2Icon className="size-3" />
            </button>
          </div>
        </div>

        {view === "code" ? (
          <pre className="bg-muted/60 max-h-64 overflow-auto rounded-md p-3 pt-8 text-xs @md:max-h-96">
            <code className="font-mono text-xs">{widget.code}</code>
          </pre>
        ) : (
          <div
            className={scrolls ? "overflow-y-auto" : "overflow-hidden"}
            style={{ height, minHeight: WIDGET_MIN_HEIGHT }}
          >
            {/* The frame is as tall as its content; the box around it caps
                that and scrolls, so a tall page does not swallow the chat. */}
            <div style={{ height: Math.max(content, WIDGET_MIN_HEIGHT) }}>
              <WidgetIframe
                key={generation}
                widget={widget}
                id={id}
                title={title}
                fill
                onHeight={onHeight}
                onError={onError}
                onPrompt={onPrompt}
              />
            </div>
          </div>
        )}

        {error !== null && (
          <div
            role="alert"
            className="text-danger mt-1 flex items-center gap-2 text-xs"
          >
            <AlertTriangleIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono" title={error}>
              {error}
            </span>
            {host.insert && (
              <button
                type="button"
                className="hover:bg-danger/10 shrink-0 rounded px-1.5 py-0.5 font-medium"
                onClick={() => host.insert?.(fixPrompt(widget.title ?? title, error))}
              >
                Ask AI to fix
              </button>
            )}
          </div>
        )}

        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent className="flex h-[90vh] flex-col gap-2 p-3 sm:max-w-[min(1200px,95vw)]">
            <DialogTitle className="pr-8 text-sm">{title}</DialogTitle>
            <div className="min-h-0 flex-1 overflow-auto rounded-md border">
              {expanded && (
                <WidgetIframe
                  widget={widget}
                  id={`${id}-full`}
                  title={title}
                  fill
                  onError={onError}
                  onPrompt={(text) => {
                    setExpanded(false)
                    onPrompt(text)
                  }}
                />
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    )
  },
  (a, b) => a.widget.code === b.widget.code && a.widget.title === b.widget.title,
)

const DEFAULT_LOADING = ["Building visual…"]

/**
 * A widget still being written: a shimmer card the size a widget will be,
 * cycling through the agent's loading messages. The frame is not mounted
 * on half a page.
 */
export function WidgetPlaceholder({
  title,
  loadingMessages,
}: {
  title: string | null
  loadingMessages?: readonly string[]
}) {
  const messages = loadingMessages?.length ? loadingMessages : DEFAULT_LOADING
  const [index, setIndex] = React.useState(0)
  React.useEffect(() => {
    if (messages.length < 2) return
    const timer = setInterval(() => setIndex((n) => (n + 1) % messages.length), 2200)
    return () => clearInterval(timer)
  }, [messages.length])

  return (
    <div
      className="bg-muted/40 my-2 flex h-40 animate-pulse items-center justify-center gap-2 rounded-md"
      data-testid="widget-placeholder"
      aria-busy="true"
      aria-label={title ? humaniseWidgetTitle(title) : "Widget"}
    >
      <SparklesIcon className="text-muted-foreground size-3 shrink-0" />
      <span className="text-muted-foreground text-xs">{messages[index % messages.length]}</span>
    </div>
  )
}

/**
 * A `show_widget` call (the built-in tool, or the MCP bridge's on Claude Code
 * and Codex), drawn as the widget its input describes. The call's input is
 * stored with the turn, so it comes back on reload like the fence does.
 */
export function ToolWidget({ name, input }: { name: string; input: unknown }) {
  const host = useWidgetHost()
  const parsed = React.useMemo(() => widgetFromToolUse(name, input), [name, input])
  if (!parsed) return null
  if (parsed.status === "streaming") {
    return <WidgetPlaceholder title={parsed.title} loadingMessages={parsed.loadingMessages} />
  }
  if (parsed.status === "too_large" || !host.enabled) {
    return (
      <pre className="bg-muted/60 my-2 max-h-64 overflow-auto rounded-md border p-3 text-xs @md:max-h-96">
        <code className="font-mono text-xs">{parsed.code}</code>
      </pre>
    )
  }
  return <WidgetFrame widget={parsed} />
}
