import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const published: Array<{ progress?: number; label?: string }> = []

vi.mock("@/components/on-demand", () => ({ ON_DEMAND: [] }))
vi.mock("@/components/prefetch", () => ({ FULL: "full", saveData: () => false }))
vi.mock("@/components/vim-editor", () => ({}))
vi.mock("@/components/notes/note-editor-impl", () => ({}))
vi.mock("@/components/git/git-view", () => ({}))
vi.mock("@/components/database/sql-editor", () => ({}))
vi.mock("@/lib/boot-progress", () => ({ publishBoot: (patch: object) => published.push(patch) }))

const WS = "wkspc0hash00"
const A = "aaaaaaaaaaaa"
const B = "bbbbbbbbbbbb"

/** The API, as the lists' fetchers see it: every project has one chat session. */
let inFlight = 0
let peak = 0
const requests: string[] = []
function fakeFetch(url: string): Promise<Response> {
  requests.push(url)
  inFlight += 1
  peak = Math.max(peak, inFlight)
  const hash = /\/api\/projects\/([a-z0-9]{12})\//.exec(url)?.[1] ?? ""
  const body = url.endsWith("/threads")
    ? { threads: [{ hash: `${hash.slice(0, 6)}chat01`, title: "Chat", branch: null }] }
    : url.endsWith("/notes")
      ? { notes: [], rootId: "" }
      : url.endsWith("/keys")
        ? { keys: [] }
        : url.endsWith("/task-settings")
          ? { settings: {} }
          : { tasks: [] }
  return new Promise((resolve) =>
    setTimeout(() => {
      inFlight -= 1
      resolve(new Response(JSON.stringify(body), { status: 200 }))
    }, 5),
  )
}

async function load() {
  vi.resetModules()
  return import("./preload")
}

function setup(extra: Record<string, unknown> = {}) {
  const prefetched: Array<{ href: string; kind: unknown }> = []
  const router = { prefetch: (href: string, options?: { kind: unknown }) => void prefetched.push({ href, kind: options?.kind }) }
  const client = new QueryClient()
  const options = {
    router,
    client,
    pathname: `/${WS}`,
    includeCurrent: false,
    workspace: { hash: WS, kind: "project" as const },
    projectHashes: [A, B],
    ...extra,
  }
  return { prefetched, client, options }
}

beforeEach(() => {
  published.length = 0
  requests.length = 0
  inFlight = 0
  peak = 0
  vi.stubGlobal("fetch", vi.fn(fakeFetch))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("preload", () => {
  it("lists each project's sessions first, then warms its conversation and pages", async () => {
    const { preload } = await load()
    const { prefetched, client, options } = setup()
    await preload(options)

    const firstOther = requests.findIndex((url) => !url.endsWith("/threads"))
    expect(requests.slice(0, firstOther).sort()).toEqual([`/api/projects/${A}/threads`, `/api/projects/${B}/threads`])
    const hrefs = prefetched.map((p) => p.href)
    expect(hrefs).toContain(`/${WS}/p/${A}/aaaaaachat01`)
    expect(hrefs).toContain(`/${WS}/p/${B}/tasks`)
    expect(prefetched.find((p) => p.href === "/setting/usage")?.kind).toBeUndefined()
    expect(prefetched.find((p) => p.href === `/${WS}/p/${A}/tasks`)?.kind).toBe("full")
    // The lists the pages open on are in the cache under the views' keys.
    expect(client.getQueryData(["tasks", "list", A])).toEqual([])
    expect(client.getQueryData(["notes", "tree", B])).toEqual({ notes: [], rootId: "" })
  })

  it("fetches lists a few at a time", async () => {
    const { preload } = await load()
    const { options } = setup({ projectHashes: Array.from({ length: 8 }, (_, i) => `p${String(i).padStart(11, "0")}`) })
    await preload(options)
    expect(peak).toBeLessThanOrEqual(3)
    expect(requests.length).toBeGreaterThan(8)
  })

  it("joins a run already going rather than starting another", async () => {
    const { preload } = await load()
    const { prefetched, options } = setup()
    await Promise.all([preload(options), preload(options)])
    const hrefs = prefetched.map((p) => p.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it("does not prefetch again what the router still holds, and does once it has let it go", async () => {
    const { preload, ROUTER_KEEPS_MS } = await load()
    const { prefetched, options } = setup()
    await preload(options)
    const first = prefetched.length

    await preload(options)
    expect(prefetched.length).toBe(first)

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + ROUTER_KEEPS_MS + 1000 })
    await preload(options)
    expect(prefetched.length).toBe(first * 2)
  })

  it("prefetches everything again after the router was refreshed", async () => {
    const { preload, forgetPrefetched, onForgotten } = await load()
    const { prefetched, options } = setup()
    const heard = vi.fn()
    onForgotten(heard)
    await preload(options)
    const first = prefetched.length
    forgetPrefetched()
    expect(heard).toHaveBeenCalledOnce()
    await preload(options)
    expect(prefetched.length).toBe(first * 2)
  })

  it("keeps only the hot set warm on a hot run, with no lists", async () => {
    const { preload } = await load()
    const { prefetched, options } = setup()
    await preload({ ...options, hotOnly: true })
    const hrefs = prefetched.map((p) => p.href)
    expect(hrefs).toContain(`/${WS}/database`)
    expect(hrefs.some((h) => h.startsWith("/setting"))).toBe(false)
    expect(hrefs.some((h) => h.endsWith("/timeline"))).toBe(false)
    expect(requests).toEqual([])
  })

  it("reports progress only when asked, never going back, ending at 1", async () => {
    const { preload } = await load()
    const { options } = setup()
    await preload(options)
    expect(published).toEqual([])

    const { preload: again } = await load()
    await again({ ...setup().options, report: true })
    const values = published.map((p) => p.progress!)
    expect(values.length).toBeGreaterThan(3)
    expect(values.at(-1)).toBe(1)
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]!)
  })
})
