"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import type { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types"

/**
 * Background prefetching for a small, fixed set of pages: the public site's
 * other tabs. The app's own shell loads far more, behind its boot screen
 * (`route-warmup.tsx`, `lib/preload.ts`); this file stays free of all that so
 * the public site's bundle does not carry it.
 */

/** `PrefetchKind.FULL`. The enum is internal to Next, so its value is named here. */
export const FULL = "full" as unknown as PrefetchKind

/** A tab away longer than this has lost its prefetched pages; they are fetched again. */
const REWARM_AFTER_MS = 4 * 60_000

/** Between two prefetches: enough for the network to breathe, short enough to finish in seconds. */
const GAP_MS = 150

/** A visitor who asked to save data, or is on 2G, is not sent anything speculative. */
export function saveData(): boolean {
  const { connection } = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  return Boolean(connection?.saveData) || /(^|-)2g$/.test(connection?.effectiveType ?? "")
}

/** After the page's `load`, at the browser's next idle moment. */
export function whenIdle(): Promise<void> {
  return new Promise((resolve) => {
    const idle = () => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(() => resolve(), { timeout: 3000 })
      else setTimeout(resolve, 1)
    }
    if (document.readyState === "complete") idle()
    else window.addEventListener("load", idle, { once: true })
  })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Prefetches `hrefs` in full, then loads `chunks`, once the page is idle --
 * and again when the tab comes back after the router has let them go.
 */
export function Prefetch({
  hrefs,
  chunks = [],
}: {
  hrefs: readonly string[]
  chunks?: ReadonlyArray<() => Promise<unknown>>
}) {
  const router = useRouter()
  // Fixed at mount: a re-render with a new array must not start over.
  const work = React.useRef({ hrefs, chunks })

  React.useEffect(() => {
    if (saveData()) return
    let cancelled = false
    const warm = async (withChunks: boolean) => {
      await whenIdle()
      for (const href of work.current.hrefs) {
        if (cancelled) return
        router.prefetch(href, { kind: FULL })
        await wait(GAP_MS)
      }
      if (!withChunks) return
      for (const load of work.current.chunks) {
        if (cancelled) return
        // A chunk that fails to arrive is fetched again when it is needed.
        await load().catch(() => {})
      }
    }
    void warm(true)

    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > REWARM_AFTER_MS) void warm(false)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [router])

  return null
}
