"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import { needsSession, safeNext } from "./auth-gate"

/**
 * Where the person last was in the app, so signing in lands there rather
 * than on the workspace list. A cookie rather than storage: the boot screen
 * reads it, and a future server redirect could.
 */
export const LAST_LOCATION_COOKIE = "ucch_last"

/** Pages not worth returning to: a one-off invite. */
const SKIP = /^\/invite\//

export function readLastLocation(): string | null {
  const raw = document.cookie.split("; ").find((c) => c.startsWith(`${LAST_LOCATION_COOKIE}=`))
  if (!raw) return null
  try {
    return safeNext(decodeURIComponent(raw.slice(LAST_LOCATION_COOKIE.length + 1)))
  } catch {
    return null
  }
}

/** In the app shell: remembers each page as it is opened. */
export function LastLocation() {
  const pathname = usePathname()
  React.useEffect(() => {
    if (!needsSession(pathname) || SKIP.test(pathname)) return
    document.cookie = `${LAST_LOCATION_COOKIE}=${encodeURIComponent(pathname)}; path=/; max-age=2592000; samesite=lax`
  }, [pathname])
  return null
}
