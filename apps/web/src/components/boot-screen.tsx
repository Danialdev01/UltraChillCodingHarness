"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { BootFrame } from "@/components/boot-frame"
import { GATE_MS } from "@/components/route-warmup"
import { safeNext } from "@/lib/auth-gate"
import { markWarm } from "@/lib/boot-cookie"
import { publishBoot, resetBoot, useBootProgress } from "@/lib/boot-progress"
import { readLastLocation } from "@/lib/last-location"
import { preload } from "@/lib/preload"
import { fetchBootstrap } from "@/lib/queries/bootstrap"
import { getQueryClient } from "@/lib/query-client"
import { qk } from "@/lib/query-keys"
import { workspaceHashFromPath } from "@/lib/sections"
import { useTransitionRouter } from "@/lib/view-transitions"

/**
 * The moment between signing in and the app: the whole app is loaded here,
 * once, so nothing after it waits on the server.
 *
 *   1. who you are, your workspaces and the open one's projects (one request,
 *      straight into the client cache the shell reads)
 *   2. the page you are going to, every other page of the workspace -- each
 *      project's conversation and pages included -- and the lists they open
 *      on (`lib/preload.ts`, within `lib/warmup.ts`'s budget)
 *
 * It goes to the page you asked for before signing in, else the last one you
 * were on, else the workspace's dashboard; never via `/`, and with no
 * `refresh()`, so nothing renders twice. The app opens when all of it is
 * loaded or after `GATE_MS`, whichever is first, and whatever is left carries
 * on behind it. The session is then marked as booted, so the app layout does
 * not draw the boot screen a second time (`lib/boot-cookie.ts`).
 */
export function BootScreen({ next }: { next: string | null }) {
  const router = useRouter()
  const go = useTransitionRouter()
  const { progress, label } = useBootProgress()

  React.useEffect(() => {
    resetBoot()
    // Before anything is prefetched: the pages warmed below render the app
    // layout, which must already know not to draw a second boot screen.
    markWarm()
    let done = false
    let target = safeNext(next) ?? readLastLocation()
    const finish = () => {
      if (done) return
      done = true
      markWarm()
      publishBoot({ progress: 1, done: true })
      go.replace(target ?? "/")
    }
    const cap = setTimeout(finish, GATE_MS)

    void (async () => {
      try {
        const client = getQueryClient()
        const boot = await fetchBootstrap(target ? workspaceHashFromPath(target) : null)
        const active = boot.workspaces.find((w) => w.id === boot.activeWorkspaceId)
        client.setQueryData(qk.bootstrap(active?.hash ?? null), boot)
        target ??= active ? `/${active.hash}` : "/"
        await preload({
          router,
          client,
          pathname: target,
          includeCurrent: true,
          workspace: active ? { hash: active.hash, kind: active.kind } : null,
          projectHashes: boot.projects.map((p) => p.hash),
          report: true,
        })
      } catch {
        // Signed in but the API stumbled: the shell will ask again itself.
      }
      clearTimeout(cap)
      finish()
    })()
    return () => clearTimeout(cap)
  }, [go, next, router])

  return <BootFrame progress={progress} label={label} />
}
