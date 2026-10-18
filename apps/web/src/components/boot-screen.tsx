"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import type { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types"

import { LogoMark } from "@/components/app-logo"
import { fetchBootstrap } from "@/lib/queries/bootstrap"
import { getQueryClient } from "@/lib/query-client"
import { qk } from "@/lib/query-keys"
import { readLastLocation } from "@/lib/last-location"
import { safeNext } from "@/lib/auth-gate"
import { warmupHrefs } from "@/lib/warmup"
import { useTransitionRouter } from "@/lib/view-transitions"

/** `PrefetchKind.FULL`; the enum is internal to Next. */
const FULL = "full" as unknown as PrefetchKind

/** However much is still loading, the app opens after this long. */
const CAP_MS = 2000

/**
 * The moment between signing in and the app: what every page needs is loaded
 * here, once, so the first page opens complete rather than as a skeleton.
 *
 *   1. who you are, your workspaces and the open one's projects (one request,
 *      straight into the client cache the shell reads)
 *   2. the page you are going to, rendered in full ahead of time
 *   3. the pages you are likeliest to open next -- the workspace's sections,
 *      its first project -- the way the shell's warmup would after its idle
 *
 * It goes to the page you asked for before signing in, else the last one you
 * were on, else the workspace's dashboard; never via `/`, and with no
 * `refresh()`, so nothing renders twice. Whatever is not done by the cap
 * carries on in the background.
 */
export function BootScreen({ next }: { next: string | null }) {
  const router = useRouter()
  const go = useTransitionRouter()
  const [progress, setProgress] = React.useState(0.08)

  React.useEffect(() => {
    let done = false
    const finish = (target: string) => {
      if (done) return
      done = true
      setProgress(1)
      go.replace(target)
    }

    void (async () => {
      const client = getQueryClient()
      let target = safeNext(next) ?? readLastLocation()
      const cap = setTimeout(() => finish(target ?? "/"), CAP_MS)
      try {
        const boot = await fetchBootstrap(target ? (/^\/([a-z0-9]{12})(?:\/|$)/.exec(target)?.[1] ?? null) : null)
        const active = boot.workspaces.find((w) => w.id === boot.activeWorkspaceId)
        client.setQueryData(qk.bootstrap(active?.hash ?? null), boot)
        target ??= active ? `/${active.hash}` : "/"
        setProgress(0.5)

        // The page itself first, then what is likely next. A prefetch says
        // nothing when it lands, so it is given a moment rather than awaited:
        // the navigation below reuses one still in flight.
        router.prefetch(target, { kind: FULL })
        const likely = warmupHrefs(
          target,
          active ? { hash: active.hash, kind: active.kind } : null,
          boot.projects.map((p) => p.hash),
        )
        for (const href of likely.slice(0, 8)) router.prefetch(href, { kind: FULL })
        await new Promise((resolve) => setTimeout(resolve, 300))
        setProgress(0.9)
      } catch {
        // Signed in but the API stumbled: the shell will ask again itself.
      }
      clearTimeout(cap)
      finish(target ?? "/")
    })()
  }, [go, next, router])

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-background fixed inset-0 z-50 flex flex-col items-center justify-center gap-6"
    >
      <LogoMark className="text-foreground size-12" />
      <div className="bg-muted h-1 w-48 overflow-hidden rounded-full">
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <p className="text-muted-foreground text-sm">Opening your workspace…</p>
    </div>
  )
}
