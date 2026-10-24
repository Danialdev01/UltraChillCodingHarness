import { describe, expect, it } from "vitest"

import type { ProjectSession } from "./session"
import { BUDGET, budgetFor, openSession, projectLists, sessionListHashes, warmupPlan, type WarmupInput } from "./warmup"

const HASH = "rdhm15c4hl8o"
const OTHER = "abcdefghijkl"
const WS = "wkspc0hash00"
const PROJECTS = { hash: WS, kind: "project" } as const
const SESSIONS = { hash: WS, kind: "session" } as const

const session = (hash: string, title = "Chat", branch: string | null = null) =>
  ({ hash, title, branch }) as unknown as ProjectSession

const hashes = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i).padStart(11, "0")}`)

const plan = (input: Partial<WarmupInput> & Pick<WarmupInput, "pathname">) =>
  warmupPlan({ includeCurrent: false, workspace: PROJECTS, projectHashes: [], ...input })

describe("BUDGET", () => {
  it("loads three projects' lists, twenty sessions lists and one file tree", () => {
    expect(BUDGET).toEqual({ projects: 3, sessionLists: 20, fileTrees: 1 })
  })
})

describe("warmupPlan routes", () => {
  it("renders no page ahead once the page is on screen", () => {
    const sessions = (h: string) => [session(`s${h.slice(1)}`)]
    const { routes } = plan({ pathname: `/${WS}/p/${HASH}/tasks`, projectHashes: hashes(30), sessions })
    expect(routes).toEqual([])
  })

  it("renders only the page about to open when asked to", () => {
    const { routes } = plan({ pathname: `/${WS}/p/${HASH}/tasks`, includeCurrent: true, projectHashes: [HASH, OTHER] })
    expect(routes).toEqual([`/${WS}/p/${HASH}/tasks`])
  })

  it("does the same without a workspace and in a session workspace", () => {
    expect(plan({ pathname: "/", workspace: null, includeCurrent: true }).routes).toEqual(["/"])
    expect(plan({ pathname: `/${WS}`, workspace: SESSIONS, projectHashes: [HASH] }).routes).toEqual([])
  })
})

describe("warmupPlan data", () => {
  it("loads each warmed project's lists, under the keys the views read", () => {
    const { data } = plan({ pathname: `/${WS}`, projectHashes: [HASH] })
    const keys = data.map((q) => JSON.stringify(q.queryKey))
    for (const family of ["tasks", "notes", "timeline", "keys"]) {
      expect(keys.some((k) => k.startsWith(`["${family}"`) && k.includes(HASH))).toBe(true)
    }
    expect(data.map((q) => q.queryKey)).toEqual(projectLists(HASH).map((q) => q.queryKey))
  })

  it("loads the lists of the budget's projects, the one in view first, and none past them", () => {
    const all = hashes(BUDGET.projects + 3)
    const { data } = plan({ pathname: `/${WS}/p/${OTHER}/tasks`, projectHashes: all })
    const listed = [...new Set(data.map((q) => q.queryKey[2]))]
    expect(listed).toEqual([OTHER, ...all.slice(0, BUDGET.projects - 1)])
  })

  it("loads the first project's file tree only, the session's worktree when it has one", () => {
    const all = hashes(BUDGET.fileTrees + 2)
    const sessions = (h: string) => [session(`s${h.slice(1)}`, "Chat", h === all[0] ? "ucch/x" : null)]
    const { data } = plan({ pathname: `/${WS}`, projectHashes: all, sessions })
    const trees = data.filter((q) => q.queryKey[0] === "files")
    expect(trees).toHaveLength(BUDGET.fileTrees)
    expect(trees[0]!.queryKey).toEqual(["files", "tree", all[0], `s${all[0]!.slice(1)}`])
  })

  it("loads no file tree for a project whose session is not known", () => {
    const { data } = plan({ pathname: `/${WS}`, projectHashes: [HASH] })
    expect(data.some((q) => q.queryKey[0] === "files")).toBe(false)
  })

  it("loads nothing in a session workspace or without a workspace", () => {
    expect(plan({ pathname: `/${WS}`, workspace: SESSIONS, projectHashes: [HASH] }).data).toEqual([])
    expect(plan({ pathname: "/", workspace: null, projectHashes: [HASH] }).data).toEqual([])
  })
})

describe("sessionListHashes", () => {
  it("lists the project in view first, up to the budget", () => {
    const all = hashes(BUDGET.sessionLists + 5)
    const listed = sessionListHashes({ pathname: `/${WS}/p/${HASH}/tasks`, workspace: PROJECTS, projectHashes: all })
    expect(listed[0]).toBe(HASH)
    expect(listed).toHaveLength(BUDGET.sessionLists)
  })

  it("lists nothing in a session workspace", () => {
    expect(sessionListHashes({ pathname: `/${WS}`, workspace: SESSIONS, projectHashes: [HASH] })).toEqual([])
  })
})

describe("budgetFor", () => {
  it("halves everything on a device with 4 GB or less", () => {
    expect(budgetFor(8)).toBe(BUDGET)
    expect(budgetFor(undefined)).toBe(BUDGET)
    expect(budgetFor(4).projects).toBe(Math.ceil(BUDGET.projects / 2))
    expect(budgetFor(2).sessionLists).toBe(BUDGET.sessionLists / 2)
    expect(budgetFor(2).fileTrees).toBe(1)
  })
})

describe("openSession", () => {
  it("is the newest session that is not a pipeline thread", () => {
    expect(openSession([session("a", "Verify: x"), session("b"), session("c")])?.hash).toBe("b")
    expect(openSession(undefined)).toBeUndefined()
  })
})
