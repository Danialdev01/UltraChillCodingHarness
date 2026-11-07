"use client"

import * as React from "react"
import { FileIcon, FolderIcon, FolderOpenIcon, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { IconKind } from "@/lib/file-icons"
import { cachedIcon, iconUrl, resolveIcon } from "@/lib/icon-resolver"

/** How many times a failed icon is asked for again, and how long to wait first. */
const RETRIES = 3
const RETRY_DELAY_MS = 1500

/** What a row shows while its image cannot be loaded. */
const FALLBACKS: Record<IconKind, LucideIcon> = {
  file: FileIcon,
  folder: FolderIcon,
  "folder-open": FolderOpenIcon,
  icon: FileIcon,
}

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
 *
 * While an image has failed, the row shows a plain file or folder glyph
 * (or the caller's `fallback`) instead of the browser's broken-image box,
 * and the retries carry on behind it: one that succeeds replaces it.
 */
export function FileTypeIcon({
  name,
  kind = "file",
  className,
  style,
  fallback,
}: {
  name: string
  kind?: IconKind
  className?: string
  style?: React.CSSProperties
  /** Drawn while the image cannot be loaded; a file or folder glyph by default. */
  fallback?: LucideIcon
}) {
  const [attempt, setAttempt] = React.useState(0)
  // The attempt whose image last failed to load, or null while none has.
  const [failedAt, setFailedAt] = React.useState<number | null>(null)
  const failed = failedAt !== null
  // The icon's id, from the batched resolver: rows that share an icon share
  // one cached image. Undefined while asking; null when it could not say,
  // which falls back to asking the server by name.
  const [id, setId] = React.useState<string | null | undefined>(() => cachedIcon(kind, name))
  // A change of name or kind is a new image, so its failures start over.
  React.useEffect(() => {
    setAttempt(0)
    setFailedAt(null)
    const known = cachedIcon(kind, name)
    setId(known)
    if (known) return
    let current = true
    void resolveIcon(kind, name).then((resolved) => current && setId(resolved))
    return () => {
      current = false
    }
  }, [name, kind])

  const query = new URLSearchParams({ kind, name })
  // The retry count in the URL is what makes the browser try again: the same
  // URL as the one that failed would be answered from its failure.
  if (attempt > 0) query.set("retry", String(attempt))

  if (id === undefined) {
    return <span aria-hidden className={cn("inline-block size-4 shrink-0", className)} style={style} />
  }

  const image = (
    <img
      src={id && attempt === 0 ? iconUrl(id) : `/file-icons?${query}`}
      alt=""
      data-file-icon=""
      width={16}
      height={16}
      decoding="async"
      className={cn("size-4 shrink-0", className)}
      style={style}
      hidden={failed}
      onLoad={() => setFailedAt(null)}
      onError={() => {
        setFailedAt(attempt)
        if (attempt >= RETRIES) return
        window.setTimeout(() => setAttempt((current) => current + 1), RETRY_DELAY_MS)
      }}
    />
  )
  if (!failed) return image

  const Fallback = fallback ?? FALLBACKS[kind]
  return (
    <>
      <Fallback aria-hidden data-file-icon="" className={cn("size-4 shrink-0", className)} style={style} />
      {/* The next retry loads hidden behind it; dropped once the last has failed. */}
      {failedAt < RETRIES && image}
    </>
  )
}
