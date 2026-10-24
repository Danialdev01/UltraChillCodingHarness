"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"

import { whenIdle } from "@/components/prefetch"
import { markWarm } from "@/lib/boot-cookie"
import { publishBoot } from "@/lib/boot-progress"
import { preload, type PreloadOptions } from "@/lib/preload"
import type { ProjectKind } from "@/lib/sections"

/**
 * Loads the app's data (`lib/preload.ts`) from inside the shell, once.
 *
 * With `gate`, this is the first page of a browser session: the app layout
 * has drawn the boot screen over it (`BootGate`), and the load starts at once
 * and reports its progress there. The app opens when everything is loaded,
 * or after `GATE_MS` at the most, with the rest carrying on behind it.
 * Without `gate` -- a reload later in the session, or the first page after
 * the sign-in boot screen already did this -- it waits for the page to be
 * idle and loads quietly; a run the boot screen left going is joined.
 *
 * Nothing is loaded again later -- not on a timer, not when the tab comes
 * back, not after a refresh. The lists stay fresh through the realtime
 * cache, and a page is rendered when it is opened.
 */

/** However much is still loading, the app opens after this long. */
export const GATE_MS = 6000

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
  // The latest of each, for the run below without restarting it.
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

    return () => {
      cancelled = true
    }
  }, [router, client, gate, wsHash, wsKind])

  return null
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
