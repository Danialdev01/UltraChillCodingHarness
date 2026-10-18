"use client"

import * as React from "react"

/**
 * A PDF in the browser's own viewer.
 *
 * Not the obvious `<iframe src>` on the served URL. That response carries a
 * `sandbox` CSP, and the frame needs `sandbox` too or a hostile file would be
 * a document on this origin -- and Chrome refuses to start its PDF viewer in
 * a sandboxed document at all, showing a "blocked" page instead of the file.
 *
 * So the bytes are fetched and wrapped in a `Blob` whose type is set here,
 * not by the response. A `blob:` URL typed `application/pdf` only ever opens
 * in the PDF viewer, which runs out of process with no access to this page:
 * a `.pdf` that is really HTML renders as a broken PDF, never as markup. That
 * is what lets the frame drop `sandbox` without letting the file in.
 *
 * `onLoad` and `onError` keep the shape of an `<iframe>`'s, so the previews
 * using this drive their loading and failure states exactly as before.
 */
export function PdfViewer({
  src,
  title,
  className,
  onLoad,
  onError,
}: {
  src: string
  title: string
  className?: string
  onLoad?: () => void
  onError?: () => void
}) {
  const [url, setUrl] = React.useState<string | null>(null)

  // The callbacks are read through a ref so a parent re-rendering with new
  // closures does not refetch the file.
  const callbacks = React.useRef({ onLoad, onError })
  React.useEffect(() => {
    callbacks.current = { onLoad, onError }
  })

  React.useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    setUrl(null)

    void (async () => {
      try {
        const response = await fetch(src, { credentials: "include" })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = await response.arrayBuffer()
        if (cancelled) return
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }))
        setUrl(objectUrl)
      } catch {
        if (!cancelled) callbacks.current.onError?.()
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [src])

  if (!url) return null

  return (
    <iframe
      src={url}
      title={title}
      onLoad={() => callbacks.current.onLoad?.()}
      className={className}
    />
  )
}
