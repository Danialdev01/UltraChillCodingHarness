"use client"

import * as React from "react"

import { ShellSkeleton } from "@/components/page-skeletons"
import { safeNext } from "@/lib/auth-gate"
import { readLastLocation } from "@/lib/last-location"
import { fetchBootstrap } from "@/lib/queries/bootstrap"
import { getQueryClient } from "@/lib/query-client"
import { qk } from "@/lib/query-keys"
import { useTransitionRouter } from "@/lib/view-transitions"

/**
 * The moment between signing in and the app: the shell's skeleton, while the
 * first page is opened. Nothing is loaded ahead here; the shell loads its
 * data once it is up (`RouteWarmup`).
 *
 * It goes to the page you asked for before signing in, else the last one you
 * were on, else the workspace's dashboard; never via `/`, and with no
 * `refresh()`, so nothing renders twice. Only the last needs asking the
 * server where that is, and its answer goes into the client cache the shell
 * reads.
 */
export function BootScreen({ next }: { next: string | null }) {
  const go = useTransitionRouter()

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      let target = safeNext(next) ?? readLastLocation()
      if (!target) {
        try {
          const boot = await fetchBootstrap(null)
          const active = boot.workspaces.find((w) => w.id === boot.activeWorkspaceId)
          getQueryClient().setQueryData(qk.bootstrap(active?.hash ?? null), boot)
          target = active ? `/${active.hash}` : "/"
        } catch {
          // Signed in but the API stumbled: the shell will ask again itself.
          target = "/"
        }
      }
      if (!cancelled) go.replace(target)
    })()
    return () => {
      cancelled = true
    }
  }, [go, next])

  return (
    <div className="bg-background fixed inset-0 z-50">
      <ShellSkeleton />
    </div>
  )
}
