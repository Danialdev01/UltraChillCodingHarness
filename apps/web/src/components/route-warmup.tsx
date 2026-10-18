"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import type { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types"

import type { ProjectKind } from "@/lib/sections"
import { SKELETON_ONLY, warmupHrefs } from "@/lib/warmup"

/**
 * Loads the rest of the app while the first page sits idle.
 *
 * A `<Link>` only prefetches what is on screen, and for a dynamic route only
 * down to its loading skeleton, so the first visit to each page still pays
 * for its JavaScript. This fetches every section, every Settings page and
 * every page of the project in view *in full* -- the RSC payload, and with it
 * the client chunks that payload names -- plus the editors that are
 * code-split out of their pages. A later click then finds it all in the
 * browser already.
 *
 * Runs once per tab, after `load` and an idle callback so the page being
 * looked at is never competing with it, one request at a time, and not at
 * all for a visitor who asked to save data. Prefetching is a production
 * feature of the router; under `next dev` the route half does nothing.
 */

/** `PrefetchKind.FULL`. The enum is internal to Next, so its value is named here. */
const FULL = "full" as unknown as PrefetchKind

/** Between two prefetches: enough for the network to breathe, short enough to finish in seconds. */
const GAP_MS = 150

/**
 * The editors each page loads only when it first shows one -- CodeMirror for
 * a file, Tiptap for a note. Both are a large share of the app's JavaScript.
 * Neither imports a stylesheet, so loading them early changes nothing on
 * screen. (tldraw is left out on purpose: it brings global CSS with it.)
 */
const EDITORS = [() => import("@/components/vim-editor"), () => import("@/components/notes/note-editor-impl")]

function saveData(): boolean {
  const { connection } = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }
  return Boolean(connection?.saveData) || /(^|-)2g$/.test(connection?.effectiveType ?? "")
}

/** After the page's `load`, at the browser's next idle moment. */
function whenIdle(): Promise<void> {
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

/** In the app shell: every section and Settings page, the project in view, and the editors. */
export function RouteWarmup({
  workspace,
  projectHashes,
}: {
  workspace: { hash: string; kind: ProjectKind } | null
  projectHashes: readonly string[]
}) {
  const pathname = usePathname()
  // The first page decides what is warmed; moving on does not start again.
  const [hrefs] = React.useState(() => warmupHrefs(pathname, workspace, projectHashes))
  return <Prefetch hrefs={hrefs} chunks={EDITORS} />
}

/**
 * Prefetches `hrefs` in full, then loads `chunks`, once the page is idle.
 * Also used by the public site's shell for its other tabs.
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
    void (async () => {
      await whenIdle()
      for (const href of work.current.hrefs) {
        if (cancelled) return
        router.prefetch(href, SKELETON_ONLY.has(href) ? undefined : { kind: FULL })
        await wait(GAP_MS)
      }
      for (const load of work.current.chunks) {
        if (cancelled) return
        // A chunk that fails to arrive is fetched again when it is needed.
        await load().catch(() => {})
      }
    })()
    return () => {
      cancelled = true
    }
  }, [router])

  return null
}
