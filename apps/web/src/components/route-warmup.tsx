"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"

import { whenIdle } from "@/components/prefetch"
import { markWarm } from "@/lib/boot-cookie"
import { publishBoot } from "@/lib/boot-progress"
import { ROUTER_KEEPS_MS, onForgotten, preload, type PreloadOptions } from "@/lib/preload"
import type { ProjectKind } from "@/lib/sections"

/**
 * Loads the rest of the app (`lib/preload.ts`) from inside the shell, and
 * keeps it loaded while the tab is in use.
 *
 * With `gate`, this is the first page of a browser session: the app layout
 * has drawn the boot screen over it (`BootGate`), and the load starts at once
 * and reports its progress there. The app opens when everything is loaded,
 * or after `GATE_MS` at the most, with the rest carrying on behind it.
 * Without `gate` -- a reload later in the session, or the first page after
 * the sign-in boot screen already did this -- it waits for the page to be
 * idle and loads quietly; a run the boot screen left going is joined.
 *
 * The router lets a prefetched page go after `ROUTER_KEEPS_MS`. While the
 * tab is in use, the likeliest pages are prefetched again as they expire;
 * coming back to a tab left longer than that, everything is.
 */

/** However much is still loading, the app opens after this long. */
export const GATE_MS = 6000

/** A tab counts as in use if someone touched it this recently. */
const ACTIVE_MS = 10 * 60_000

export function RouteWarmup({
  workspace,
  projectHashes,
  gate,
}: {
  workspace: { hash: string; kind: ProjectKind } | null
  projectHashes: readonly string[]
  gate: boolean
}) {
  const router = useRouter()
  const client = useQueryClient()
  const pathname = usePathname()
  // The latest of each, for the timers below without restarting them.
  const live = React.useRef({ pathname, projectHashes })
  live.current = { pathname, projectHashes }
  const wsHash = workspace?.hash ?? null
  const wsKind = workspace?.kind ?? null

  React.useEffect(() => {
    let cancelled = false
    const options = (extra: Partial<PreloadOptions> = {}): PreloadOptions => ({
      router,
      client,
      pathname: live.current.pathname,
      includeCurrent: false,
      workspace: wsHash && wsKind ? { hash: wsHash, kind: wsKind } : null,
      projectHashes: live.current.projectHashes,
      ...extra,
    })

    if (gate) {
      const open = () => {
        if (cancelled) return
        markWarm()
        publishBoot({ done: true })
      }
      void Promise.race([preload(options({ report: true })), wait(GATE_MS)]).then(open, open)
    } else {
      void whenIdle().then(() => {
        if (!cancelled) void preload(options())
      })
    }

    let lastActive = Date.now()
    const onActivity = () => {
      lastActive = Date.now()
    }
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > ROUTER_KEEPS_MS - 60_000) void preload(options())
    }
    // Just after the router lets the last round go: the likeliest pages again.
    const hot = window.setInterval(() => {
      if (document.visibilityState !== "visible" || Date.now() - lastActive > ACTIVE_MS) return
      void preload(options({ hotOnly: true }))
    }, ROUTER_KEEPS_MS + 5000)

    // The page was rendered again and the router let everything go with it.
    let refetch: number | undefined
    const offForgotten = onForgotten(() => {
      window.clearTimeout(refetch)
      refetch = window.setTimeout(() => void preload(options()), 2000)
    })

    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pointerdown", onActivity, { passive: true })
    window.addEventListener("keydown", onActivity, { passive: true })
    return () => {
      cancelled = true
      window.clearInterval(hot)
      window.clearTimeout(refetch)
      offForgotten()
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pointerdown", onActivity)
      window.removeEventListener("keydown", onActivity)
    }
  }, [router, client, gate, wsHash, wsKind])

  return null
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
