import { describe, expect, it } from "vitest"

import { PROJECT_PAGES, SECTIONS, SETTINGS_PAGES, sectionHref, settingsPageHref } from "./sections"
import type { ProjectSession } from "./session"
import { BUDGET, SKELETON_ONLY, budgetFor, openSession, sessionListHashes, warmupPlan, type WarmupInput } from "./warmup"

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

describe("warmupPlan routes", () => {
  it("covers every section and every Settings page", () => {
    const { routes } = plan({ pathname: `/${WS}` })
    for (const s of SECTIONS.slice(1)) expect(routes).toContain(sectionHref(s, WS))
    for (const p of SETTINGS_PAGES) expect(routes).toContain(settingsPageHref(p.id))
  })

  it("leaves out the page in view and the /setting redirect stub", () => {
    const { routes } = plan({ pathname: `/${WS}` })
    expect(routes).not.toContain(`/${WS}`)
    expect(routes).not.toContain("/setting")
  })

  it("puts the page about to open first when asked to", () => {
    const { routes } = plan({ pathname: `/${WS}/p/${HASH}/tasks`, includeCurrent: true })
    expect(routes[0]).toBe(`/${WS}/p/${HASH}/tasks`)
  })

  it("warms every page of every project, the one in view first", () => {
    const { routes } = plan({ pathname: `/${WS}/p/${HASH}/tasks`, projectHashes: [OTHER, HASH] })
    for (const p of PROJECT_PAGES) {
      if (p.id !== "tasks") expect(routes).toContain(`/${WS}/p/${HASH}/${p.id}`)
      expect(routes).toContain(`/${WS}/p/${OTHER}/${p.id}`)
    }
    expect(routes).not.toContain(`/${WS}/p/${HASH}/tasks`)
    expect(routes.indexOf(`/${WS}/p/${HASH}/timeline`)).toBeLessThan(routes.indexOf(`/${WS}/p/${OTHER}/tasks`))
  })

  it("puts the rail's sections before the projects and Settings last", () => {
    const { routes } = plan({ pathname: `/${WS}`, projectHashes: [HASH] })
    const section = routes.indexOf(sectionHref(SECTIONS[1], WS))
    expect(section).toBeLessThan(routes.indexOf(`/${WS}/p/${HASH}/tasks`))
    expect(routes.indexOf(`/${WS}/p/${HASH}/tasks`)).toBeLessThan(routes.indexOf(settingsPageHref("account")))
  })

  it("warms a project's open session, passing over Tasks-board threads", () => {
    const sessions = { [HASH]: [session("taskthread01", "Task: build it"), session("chatsession1")] }
    const { routes } = plan({ pathname: `/${WS}`, projectHashes: [HASH], sessions: (h) => sessions[h as typeof HASH] })
    expect(routes).toContain(`/${WS}/p/${HASH}/chatsession1`)
    expect(routes.some((r) => r.includes("taskthread01"))).toBe(false)
    // The bare address only redirects there; it is not warmed as well.
    expect(routes).not.toContain(`/${WS}/p/${HASH}`)
  })

  it("warms a project's bare address when it has no session to open", () => {
    const sessions = { [HASH]: [session("taskthread01", "Task: build it")] }
    const { routes, hot } = plan({ pathname: `/${WS}`, projectHashes: [HASH], sessions: (h) => sessions[h as typeof HASH] })
    expect(routes).toContain(`/${WS}/p/${HASH}`)
    expect(hot).toContain(`/${WS}/p/${HASH}`)
  })

  it("warms every project up to the budget and none past it", () => {
    const all = hashes(BUDGET.projects + 3)
    const { routes } = plan({ pathname: `/${WS}`, projectHashes: all })
    for (const hash of all.slice(0, BUDGET.projects)) expect(routes).toContain(`/${WS}/p/${hash}/tasks`)
    for (const hash of all.slice(BUDGET.projects)) expect(routes.some((r) => r.includes(hash))).toBe(false)
  })

  it("in a session workspace, warms the sessions rather than project pages", () => {
    const { routes, data } = plan({ pathname: `/${WS}`, workspace: SESSIONS, projectHashes: [HASH] })
    expect(routes).toContain(`/${WS}/s/${HASH}`)
    expect(routes.some((h) => h.includes("/p/"))).toBe(false)
    expect(data).toEqual([])
  })

  it("without a workspace, warms only the global pages", () => {
    const { routes } = plan({ pathname: "/", workspace: null, projectHashes: [HASH] })
    expect(routes.every((h) => h === "/" || h.startsWith("/setting"))).toBe(true)
  })

  it("has no duplicates", () => {
    const { routes, hot } = plan({ pathname: `/${WS}/code`, projectHashes: [HASH, HASH] })
    expect(new Set(routes).size).toBe(routes.length)
    expect(new Set(hot).size).toBe(hot.length)
  })

  it("only skeleton-prefetches pages that are listed", () => {
    for (const href of SKELETON_ONLY) expect(plan({ pathname: `/${WS}` }).routes).toContain(href)
  })
})

describe("warmupPlan hot set", () => {
  it("is the sections and the first projects' session and board, inside the routes", () => {
    const all = hashes(BUDGET.hot + 2)
    const sessions = (h: string) => [session(`s${h.slice(1)}`)]
    const { routes, hot } = plan({ pathname: `/${WS}`, projectHashes: all, sessions })
    for (const href of hot) expect(routes).toContain(href)
    expect(hot).toContain(sectionHref(SECTIONS[1], WS))
    for (const hash of all.slice(0, BUDGET.hot)) {
      expect(hot).toContain(`/${WS}/p/${hash}/s${hash.slice(1)}`)
      expect(hot).toContain(`/${WS}/p/${hash}/tasks`)
    }
    for (const hash of all.slice(BUDGET.hot)) expect(hot.some((r) => r.includes(hash))).toBe(false)
  })
})

describe("warmupPlan data", () => {
  it("loads each warmed project's lists, under the keys the views read", () => {
    const { data } = plan({ pathname: `/${WS}`, projectHashes: [HASH] })
    const keys = data.map((q) => JSON.stringify(q.queryKey))
    for (const family of ["tasks", "notes", "timeline", "keys"]) {
      expect(keys.some((k) => k.startsWith(`["${family}"`) && k.includes(HASH))).toBe(true)
    }
  })

  it("loads file trees for the first few projects only, the session's worktree when it has one", () => {
    const all = hashes(BUDGET.fileTrees + 2)
    const sessions = (h: string) => [session(`s${h.slice(1)}`, "Chat", h === all[0] ? "ucch/x" : null)]
    const { data } = plan({ pathname: `/${WS}`, projectHashes: all, sessions })
    const trees = data.filter((q) => q.queryKey[0] === "files")
    expect(trees).toHaveLength(BUDGET.fileTrees)
    expect(trees[0]!.queryKey).toEqual(["files", "tree", all[0], `s${all[0]!.slice(1)}`])
    expect(trees[1]!.queryKey).toEqual(["files", "tree", all[1], null])
  })

  it("loads no file tree for a project whose session is not known", () => {
    const { data } = plan({ pathname: `/${WS}`, projectHashes: [HASH] })
    expect(data.some((q) => q.queryKey[0] === "files")).toBe(false)
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
    expect(budgetFor(4).projects).toBe(BUDGET.projects / 2)
    expect(budgetFor(2).fileTrees).toBe(Math.ceil(BUDGET.fileTrees / 2))
  })
})

describe("openSession", () => {
  it("is the newest session that is not a pipeline thread", () => {
    expect(openSession([session("a", "Verify: x"), session("b"), session("c")])?.hash).toBe("b")
    expect(openSession(undefined)).toBeUndefined()
  })
})
