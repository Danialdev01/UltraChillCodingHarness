import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/components/on-demand", () => ({ ON_DEMAND: [] }))
vi.mock("@/components/prefetch", () => ({ saveData: () => false }))
vi.mock("@/components/vim-editor", () => ({}))
vi.mock("@/components/notes/note-editor-impl", () => ({}))
vi.mock("@/components/git/git-view", () => ({}))
vi.mock("@/components/database/sql-editor", () => ({}))

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
  const client = new QueryClient()
  const options = {
    client,
    pathname: `/${WS}`,
    workspace: { hash: WS, kind: "project" as const },
    projectHashes: [A, B],
    ...extra,
  }
  return { client, options }
}

beforeEach(() => {
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
  it("lists each project's sessions first, then loads the lists its pages open on", async () => {
    const { preload } = await load()
    const { client, options } = setup()
    await preload(options)

    const firstOther = requests.findIndex((url) => !url.endsWith("/threads"))
    expect(requests.slice(0, firstOther).sort()).toEqual([`/api/projects/${A}/threads`, `/api/projects/${B}/threads`])
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
    const { options } = setup()
    await Promise.all([preload(options), preload(options)])
    expect(requests.filter((url) => url.endsWith("/threads"))).toHaveLength(2)
  })

  it("has nothing to re-warm with: no forgetting, no hot set", async () => {
    const preload = await load()
    expect(Object.keys(preload).sort()).toEqual(["prefetchProject", "preload"])
  })

  it("loads a hovered project's sessions and lists, once while they are fresh", async () => {
    const { prefetchProject } = await load()
    const { client } = setup()
    prefetchProject(client, B)
    await vi.waitFor(() => expect(client.getQueryData(["tasks", "list", B])).toEqual([]))
    const first = requests.length
    expect(requests).toContain(`/api/projects/${B}/threads`)
    prefetchProject(client, B)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(requests.length).toBe(first)
  })
})
