"use client"

import type { QueryClient } from "@tanstack/react-query"

import { ON_DEMAND } from "@/components/on-demand"
import { saveData } from "@/components/prefetch"
import { projectQueries, type ProjectQuery } from "@/lib/queries/project-data"
import type { ProjectKind } from "@/lib/sections"
import type { ProjectSession } from "@/lib/session"
import { budgetFor, projectLists, sessionListHashes, warmupPlan } from "@/lib/warmup"

/**
 * Loads the app's data ahead of the person using it: the lists the recent
 * projects' pages open on, and the code-split editors -- so that a click on
 * one of those projects shows its content at once, not only its skeleton.
 * No page is rendered ahead.
 *
 * What is loaded, and how much, is `lib/warmup.ts`'s plan and budget. This
 * file runs it: the sessions lists first (which session's file tree to load
 * depends on them), then lists and chunks side by side, a few at a time
 * each. The shell runs it once (`RouteWarmup`): nothing loads it again on a
 * timer or after a refresh, since the lists stay fresh through the realtime
 * cache. A second run for the same workspace while one is going joins it.
 */

/**
 * A list loaded ahead that nothing has shown for this long is dropped from
 * memory. (A list a view has shown keeps the cache's own, longer, lifetime.)
 */
const WARM_GC_MS = 30 * 60_000

/** A list fetched more recently than this is not fetched again by a later run. */
const DATA_FRESH_MS = 5 * 60_000

/** How many lists are fetched at once. */
const DATA_LANES = 3

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

export interface PreloadOptions {
  client: QueryClient
  /** The page in view. */
  pathname: string
  workspace: { hash: string; kind: ProjectKind } | null
  /** The workspace's projects, most recently active first. */
  projectHashes: readonly string[]
}

let chunksLoaded = false
let running: { key: string; done: Promise<void> } | null = null

/**
 * Loads what `options` describes; resolves when all of it is loaded. A run
 * already going for the same workspace is joined instead.
 */
export function preload(options: PreloadOptions): Promise<void> {
  const key = options.workspace?.hash ?? ""
  if (running?.key === key) return running.done
  const previous = running?.done ?? Promise.resolve()
  const done = previous.then(() => run(options)).finally(() => {
    if (running?.done === done) running = null
  })
  running = { key, done }
  return done
}

async function run(options: PreloadOptions): Promise<void> {
  const { client, workspace, pathname, projectHashes } = options
  const budget = budgetFor((navigator as Navigator & { deviceMemory?: number }).deviceMemory)

  // Asked to save data: nothing speculative.
  if (saveData()) return

  // 1. Which session each project opens on, so its links are the
  //    conversation itself rather than a redirect to it.
  const listed = sessionListHashes({ pathname, workspace, projectHashes, budget })
  await inLanes(listed, DATA_LANES, (hash) => prefetchData(client, projectQueries.sessions(hash)))

  const { data } = warmupPlan({
    pathname,
    workspace,
    projectHashes,
    sessions: (hash) => client.getQueryData<ProjectSession[]>(projectQueries.sessions(hash).queryKey),
    budget,
  })
  const chunks = chunksLoaded ? [] : CHUNKS
  chunksLoaded = true

  // 2. Lists and chunks side by side.
  await Promise.all([
    inLanes(data, DATA_LANES, (query) => prefetchData(client, query)),
    inLanes(chunks, 1, async (load) => {
      // A chunk that fails to arrive is fetched again when it is needed.
      await load().catch(() => {})
    }),
  ])
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
