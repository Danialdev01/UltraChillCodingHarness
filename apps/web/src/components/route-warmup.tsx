"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"

import { whenIdle } from "@/components/prefetch"
import { preload } from "@/lib/preload"
import { useShell } from "@/lib/workspace-context"

/**
 * Loads the app's data (`lib/preload.ts`) from inside the shell, once the
 * page is idle, so nothing it fetches competes with the page itself.
 *
 * Nothing is loaded again later -- not on a timer, not when the tab comes
 * back, not after a refresh. The lists stay fresh through the realtime
 * cache, and a page is rendered when it is opened.
 */
export function RouteWarmup() {
  const { workspace, projects, loading } = useShell()
  const projectHashes = React.useMemo(() => projects.map((p) => p.hash), [projects])
  const client = useQueryClient()
  const pathname = usePathname()
  // The latest of each, for the run below without restarting it.
  const live = React.useRef({ pathname, projectHashes })
  live.current = { pathname, projectHashes }
  const wsHash = workspace?.hash ?? null
  const wsKind = workspace?.kind ?? null

  React.useEffect(() => {
    // The project list is what there is to warm.
    if (loading) return
    let cancelled = false
    void whenIdle().then(() => {
      if (cancelled) return
      void preload({
        client,
        pathname: live.current.pathname,
        workspace: wsHash && wsKind ? { hash: wsHash, kind: wsKind } : null,
        projectHashes: live.current.projectHashes,
      })
    })
    return () => {
      cancelled = true
    }
  }, [client, wsHash, wsKind, loading])

  return null
}
