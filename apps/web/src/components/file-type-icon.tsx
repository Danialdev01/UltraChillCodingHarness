"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import type { IconKind } from "@/lib/file-icons"

/** How many times a failed icon is asked for again, and how long to wait first. */
const RETRIES = 3
const RETRY_DELAY_MS = 1500

/**
 * A Material file-type icon for a row in the tree.
 *
 * An image rather than an inline SVG: the set is 1,250 icons, resolved on
 * the server by name (see `app/file-icons/route.ts`), and the browser caches
 * each URL it has seen. Decorative -- the name beside it is the label -- so
 * the alt text is empty.
 *
 * A failed load is retried with a fresh URL. The browser will not ask for an
 * image again once it has failed, so a hiccup on the server -- a dev server
 * mid-recompile, say -- would otherwise leave that row blank until the page
 * is reloaded. Eager rather than lazy: the icons are tiny, and the panel
 * they sit in slides in from off-screen, which is exactly when a lazy image
 * is at risk of never being asked for.
 */
export function FileTypeIcon({
  name,
  kind = "file",
  className,
  style,
}: {
  name: string
  kind?: IconKind
  className?: string
  style?: React.CSSProperties
}) {
  const [attempt, setAttempt] = React.useState(0)
  // A change of name or kind is a new image, so its failures start over.
  React.useEffect(() => setAttempt(0), [name, kind])

  const query = new URLSearchParams({ kind, name })
  // The retry count in the URL is what makes the browser try again: the same
  // URL as the one that failed would be answered from its failure.
  if (attempt > 0) query.set("retry", String(attempt))

  return (
    <img
      src={`/file-icons?${query}`}
      alt=""
      width={16}
      height={16}
      decoding="async"
      className={cn("size-4 shrink-0", className)}
      style={style}
      onError={() => {
        if (attempt >= RETRIES) return
        window.setTimeout(() => setAttempt((current) => current + 1), RETRY_DELAY_MS)
      }}
    />
  )
}
