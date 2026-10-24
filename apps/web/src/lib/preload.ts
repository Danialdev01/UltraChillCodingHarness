"use client"

import type { QueryClient } from "@tanstack/react-query"
import type { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types"

import { ON_DEMAND } from "@/components/on-demand"
import { FULL, saveData } from "@/components/prefetch"
import { publishBoot } from "@/lib/boot-progress"
import { projectQueries, type ProjectQuery } from "@/lib/queries/project-data"
import type { ProjectKind } from "@/lib/sections"
import type { ProjectSession } from "@/lib/session"
import { SKELETON_ONLY, budgetFor, projectLists, sessionListHashes, warmupPlan } from "@/lib/warmup"

/**
 * Loads the app's data ahead of the person using it: the lists the recent
 * projects' pages open on, and the code-split editors -- so that a click on
 * one of those projects shows its content at once, not only its skeleton.
 * No page is rendered ahead but the one about to open.
 *
 * What is loaded, and how much, is `lib/warmup.ts`'s plan and budget. This
 * file runs it: the sessions lists first (which session's file tree to load
 * depends on them), then the page, lists and chunks side by side, a few at a
 * time each. It runs once per shell: nothing loads it again on a timer or
 * after a refresh, since the lists stay fresh through the realtime cache.
 *
 * One run at a time per tab. The sign-in boot screen starts one; the shell
 * mounting while it is still going joins it rather than starting another.
 */

/**
 * A list loaded ahead that nothing has shown for this long is dropped from
 * memory. (A list a view has shown keeps the cache's own, longer, lifetime.)
 */
const WARM_GC_MS = 30 * 60_000

/** A list fetched more recently than this is not fetched again by a later run. */
const DATA_FRESH_MS = 5 * 60_000

/** How many pages are rendered at once, and how many lists fetched. */
const ROUTE_LANES = 4
const DATA_LANES = 3

/** A prefetch whose response has not been seen by now is counted as done. */
const ROUTE_TIMEOUT_MS = 5000

/**
 * The parts of the app each page loads only when it first shows one:
 * CodeMirror for a file or a SQL console, Tiptap for a note, the Git view,
 * and the shell's dialogs. None imports a stylesheet, so loading one early
 * changes nothing on screen. Left out on purpose: the terminal and tldraw,
 * which bring global CSS with them, and mermaid, which is large enough that
 * keeping it in memory for a diagram that may never be opened is not worth it.
 */
const CHUNKS: ReadonlyArray<() => Promise<unknown>> = [
  ...ON_DEMAND,
  () => import("@/components/vim-editor"),
  () => import("@/components/notes/note-editor-impl"),
  () => import("@/components/git/git-view"),
  () => import("@/components/database/sql-editor"),
]

type Router = { prefetch(href: string, options?: { kind: PrefetchKind }): void }

export interface PreloadOptions {
  router: Router
  client: QueryClient
  /** The page in view, or the one about to be opened. */
  pathname: string
  /** Whether `pathname` itself is to be loaded: yes before it opens, no once it is on screen. */
  includeCurrent: boolean
  workspace: { hash: string; kind: ProjectKind } | null
  /** The workspace's projects, most recently active first. */
  projectHashes: readonly string[]
  /** Show this run's progress on the boot screen. */
  report?: boolean
}

let chunksLoaded = false
let running: { key: string; done: Promise<void> } | null = null
let reporting = false

/**
 * Loads what `options` describes; resolves when all of it is loaded. A run
 * already going for the same workspace is joined instead.
 */
export function preload(options: PreloadOptions): Promise<void> {
  if (options.report) reporting = true
  const key = options.workspace?.hash ?? ""
  if (running?.key === key) return running.done
  const previous = running?.done ?? Promise.resolve()
  const done = previous.then(() => run(options)).finally(() => {
    if (running?.done === done) {
      running = null
      reporting = false
    }
  })
  running = { key, done }
  return done
}

function report(patch: { progress: number; label: string }): void {
  if (reporting) publishBoot(patch)
}

async function run(options: PreloadOptions): Promise<void> {
  const { client, router, workspace, pathname, projectHashes } = options
  const budget = budgetFor((navigator as Navigator & { deviceMemory?: number }).deviceMemory)

  // Asked to save data: the page about to open, and nothing speculative.
  if (saveData()) {
    if (options.includeCurrent) await prefetchRoutes(router, [pathname], () => {})
    return
  }

  // 1. Which session each project opens on, so its links are the
  //    conversation itself rather than a redirect to it.
  const listed = sessionListHashes({ pathname, workspace, projectHashes, budget })
  let listsDone = 0
  if (listed.length) report({ progress: 0.08, label: "Finding your projects" })
  await inLanes(listed, DATA_LANES, async (hash) => {
    await prefetchData(client, projectQueries.sessions(hash))
    listsDone += 1
    report({ progress: 0.08 + 0.12 * (listsDone / listed.length), label: "Finding your projects" })
  })

  const plan = warmupPlan({
    pathname,
    includeCurrent: options.includeCurrent,
    workspace,
    projectHashes,
    sessions: (hash) => client.getQueryData<ProjectSession[]>(projectQueries.sessions(hash).queryKey),
    budget,
  })
  const { routes, data } = plan
  const chunks = chunksLoaded ? [] : CHUNKS
  chunksLoaded = true

  // 2. The page, lists and chunks side by side.
  const total = routes.length + data.length + chunks.length
  let done = 0
  let pagesDone = 0
  const step = (page = false) => {
    done += 1
    if (page) pagesDone += 1
    report({
      progress: 0.2 + 0.8 * (done / Math.max(total, 1)),
      label: routes.length ? `Preparing pages · ${pagesDone} of ${routes.length}` : "Preparing your workspace",
    })
  }
  await Promise.all([
    prefetchRoutes(router, routes, () => step(true)),
    inLanes(data, DATA_LANES, async (query) => {
      await prefetchData(client, query)
      step()
    }),
    inLanes(chunks, 1, async (load) => {
      // A chunk that fails to arrive is fetched again when it is needed.
      await load().catch(() => {})
      step()
    }),
  ])
  report({ progress: 1, label: "Ready" })
}

/**
 * A project's lists, on the pointer coming over its row in the sidebar: the
 * click that likely follows then shows content rather than a skeleton, for
 * a few small API requests and no page render. A list fetched recently is
 * not fetched again.
 */
export function prefetchProject(client: QueryClient, hash: string): void {
  if (saveData()) return
  for (const query of [projectQueries.sessions(hash), ...projectLists(hash)]) void prefetchData(client, query)
}

function prefetchData(client: QueryClient, query: ProjectQuery<unknown>): Promise<void> {
  return client.prefetchQuery({
    queryKey: query.queryKey,
    queryFn: query.queryFn,
    meta: query.persist ? { persist: true } : undefined,
    staleTime: DATA_FRESH_MS,
    gcTime: WARM_GC_MS,
  })
}

/** Runs `work` over `items`, `lanes` at a time, in order. */
async function inLanes<T>(items: readonly T[], lanes: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++]!
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane))
}

/**
 * Prefetches `hrefs` in full, `ROUTE_LANES` at a time. The router says
 * nothing when a prefetch lands, so the response is seen in the browser's
 * resource timings instead; one that does not show up (the router already
 * had the page, say) is let go after a few seconds.
 */
async function prefetchRoutes(router: Router, hrefs: readonly string[], onEach: () => void): Promise<void> {
  // `next dev` does not prefetch: there is nothing to wait for.
  const watched = process.env.NODE_ENV === "production" && watchResponses()
  await inLanes(hrefs, ROUTE_LANES, async (href) => {
    const landed = watched ? responseFor(href) : Promise.resolve()
    router.prefetch(href, SKELETON_ONLY.has(href) ? undefined : { kind: FULL })
    await landed
    onEach()
  })
}

/** Prefetches awaiting their response, by pathname. */
const awaiting = new Map<string, () => void>()
let observer: PerformanceObserver | null = null

function watchResponses(): boolean {
  if (observer) return true
  if (typeof PerformanceObserver === "undefined") return false
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      let url: URL
      try {
        url = new URL(entry.name)
      } catch {
        continue
      }
      // An RSC request: the router's own, for a page or a prefetch of one.
      if (url.searchParams.has("_rsc")) awaiting.get(url.pathname)?.()
    }
  })
  try {
    observer.observe({ type: "resource" })
  } catch {
    observer = null
    return false
  }
  return true
}

function responseFor(href: string): Promise<void> {
  const path = href.split("?")[0]!
  return new Promise((resolve) => {
    const settle = () => {
      clearTimeout(timer)
      if (awaiting.get(path) === settle) awaiting.delete(path)
      resolve()
    }
    const timer = setTimeout(settle, ROUTE_TIMEOUT_MS)
    awaiting.set(path, settle)
  })
}
