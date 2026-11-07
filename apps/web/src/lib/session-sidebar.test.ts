import { describe, expect, it } from "vitest"

import {
  compareSessions,
  dateBucket,
  filterReducer,
  filtersActive,
  groupByProject,
  highlightRanges,
  matchSession,
  NO_FILTERS,
  passesFilters,
  relativeTime,
  sortSessions,
  statusOf,
  type SidebarProject,
  type SidebarSession,
} from "./session-sidebar"

const BAKERY: SidebarProject = { id: "p1", hash: "bakery000001", name: "BakeryShop", stack: "laravel" }
const DBOT: SidebarProject = { id: "p2", hash: "dbot00000002", name: "dbot", stack: "node" }
const EMPTY: SidebarProject = { id: "p3", hash: "empty0000003", name: "Empty", stack: null, lastActiveAt: "2026-11-01T00:00:00Z" }

let n = 0
function session(over: Partial<SidebarSession> = {}): SidebarSession {
  n++
  return {
    id: `s${n}`,
    hash: `hash${n}`,
    title: `Session ${n}`,
    status: "idle",
    provider: "claude",
    model: "claude-opus-5-5",
    lastTurn: null,
    branch: "main",
    baseBranch: null,
    worktreeState: null,
    pinned: false,
    archivedAt: null,
    lastActivityAt: "2026-11-07T10:00:00Z",
    createdAt: "2026-11-07T09:00:00Z",
    createdByUserId: "me",
    project: BAKERY,
    ...over,
  }
}

describe("statusOf", () => {
  it("reads the row until the socket says otherwise", () => {
    expect(statusOf(session())).toBe("idle")
    expect(statusOf(session({ lastTurn: "done" }))).toBe("settled")
    expect(statusOf(session({ lastTurn: "stopped" }))).toBe("idle")
    expect(statusOf(session({ lastTurn: "failed" }))).toBe("error")
    expect(statusOf(session({ status: "error" }))).toBe("error")
    expect(statusOf(session({ status: "queued" }))).toBe("running")
    expect(statusOf(session({ status: "running", lastTurn: "done" }))).toBe("running")
    expect(statusOf(session({ archivedAt: "2026-11-01T00:00:00Z", status: "running" }))).toBe("archived")
  })

  it("prefers what it heard live", () => {
    const s = session({ lastTurn: "done" })
    expect(statusOf(s, "running")).toBe("running")
    expect(statusOf(s, "waiting")).toBe("waiting_input")
    expect(statusOf(s, "failed")).toBe("error")
    expect(statusOf(session(), "done")).toBe("settled")
    expect(statusOf(s, "idle")).toBe("idle")
  })
})

describe("ordering", () => {
  it("puts pinned first, then the newest activity", () => {
    const old = session({ title: "old", lastActivityAt: "2026-11-01T00:00:00Z" })
    const recent = session({ title: "recent", lastActivityAt: "2026-11-07T11:00:00Z" })
    const pinned = session({ title: "pinned", pinned: true, lastActivityAt: "2026-10-01T00:00:00Z" })
    expect(sortSessions([old, recent, pinned]).map((s) => s.title)).toEqual(["pinned", "recent", "old"])
    expect(compareSessions(recent, recent)).toBe(0)
  })

  it("buckets by local day", () => {
    const now = new Date(2026, 10, 7, 15, 0)
    const at = (d: Date) => session({ lastActivityAt: d.toISOString() })
    expect(dateBucket(at(new Date(2026, 10, 7, 1, 0)), now)).toBe("Today")
    expect(dateBucket(at(new Date(2026, 10, 6, 23, 0)), now)).toBe("Yesterday")
    expect(dateBucket(at(new Date(2026, 10, 3, 12, 0)), now)).toBe("This week")
    expect(dateBucket(at(new Date(2026, 9, 1)), now)).toBe("Older")
    expect(dateBucket(session({ pinned: true }), now)).toBe("Pinned")
  })
})

describe("groupByProject", () => {
  it("groups under every project, empty ones too, busiest first", () => {
    const a = session({ project: BAKERY, lastActivityAt: "2026-11-05T00:00:00Z" })
    const b = session({ project: DBOT, lastActivityAt: "2026-11-07T00:00:00Z" })
    const c = session({ project: DBOT, lastActivityAt: "2026-11-06T00:00:00Z", pinned: true })
    const groups = groupByProject([a, b, c], [BAKERY, DBOT, EMPTY])
    expect(groups.map((g) => g.project.name)).toEqual(["dbot", "BakeryShop", "Empty"])
    // Inside a group, sessions sort as in the flat list.
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual([c.id, b.id])
    expect(groups[2]!.sessions).toEqual([])
  })

  it("keeps a session whose project is not in the list", () => {
    const stray = session({ project: { id: "p9", hash: "stray0000009", name: "Stray", stack: null } })
    expect(groupByProject([stray], []).map((g) => g.project.name)).toEqual(["Stray"])
  })
})

describe("search", () => {
  const s = session({ title: "Identify project purpose", branch: "feature/login", provider: "codex", model: "gpt-5-codex" })

  it("matches title, project, branch and model, every word somewhere", () => {
    expect(matchSession(s, "")).toBe(true)
    expect(matchSession(s, "identify")).toBe(true)
    expect(matchSession(s, "bakery")).toBe(true)
    expect(matchSession(s, "LOGIN")).toBe(true)
    expect(matchSession(s, "gpt-5 codex")).toBe(true)
    expect(matchSession(s, "purpose bakery")).toBe(true)
    expect(matchSession(s, "purpose opus")).toBe(false)
  })

  it("marks each match once, merged where they overlap", () => {
    expect(highlightRanges("Identify project purpose", "pro")).toEqual([[9, 12]])
    expect(highlightRanges("Identify project purpose", "pur j")).toEqual([[12, 13], [17, 20]])
    expect(highlightRanges("aaaa", "aa a")).toEqual([[0, 4]])
    expect(highlightRanges("anything", "  ")).toEqual([])
  })
})

describe("filters", () => {
  it("toggles, sets and clears", () => {
    let f = filterReducer(NO_FILTERS, { type: "toggleHarness", harness: "codex" })
    expect(f.harnesses).toEqual(["codex"])
    expect(filtersActive(f)).toBe(true)
    f = filterReducer(f, { type: "toggleHarness", harness: "codex" })
    expect(f.harnesses).toEqual([])
    f = filterReducer(f, { type: "toggleStatus", status: "error" })
    f = filterReducer(f, { type: "toggleProject", projectId: "p1" })
    f = filterReducer(f, { type: "createdBy", value: "me" })
    f = filterReducer(f, { type: "showArchived", value: true })
    expect(f).toEqual({ harnesses: [], statuses: ["error"], projects: ["p1"], createdBy: "me", showArchived: true })
    // Setting what is already set is the same object: no re-render.
    expect(filterReducer(f, { type: "createdBy", value: "me" })).toBe(f)
    expect(filterReducer(f, { type: "clear" })).toBe(NO_FILTERS)
    expect(filtersActive(NO_FILTERS)).toBe(false)
  })

  it("keeps what every filter allows", () => {
    const mine = session({ provider: "omp", createdByUserId: "me" })
    const theirs = session({ provider: "codex", createdByUserId: "them", project: DBOT })
    const unknown = session({ provider: "gemini" })
    const ctx = (status: "idle" | "archived" | "error" = "idle") => ({ userId: "me", status })
    const keep = (f: typeof NO_FILTERS, s: SidebarSession, status?: "idle" | "archived" | "error") =>
      passesFilters(s, f, ctx(status))

    expect(keep(NO_FILTERS, mine)).toBe(true)
    expect(keep({ ...NO_FILTERS, harnesses: ["ucch"] }, mine)).toBe(true)
    expect(keep({ ...NO_FILTERS, harnesses: ["ucch"] }, theirs)).toBe(false)
    expect(keep({ ...NO_FILTERS, harnesses: ["unknown"] }, unknown)).toBe(true)
    expect(keep({ ...NO_FILTERS, projects: ["p2"] }, theirs)).toBe(true)
    expect(keep({ ...NO_FILTERS, projects: ["p2"] }, mine)).toBe(false)
    expect(keep({ ...NO_FILTERS, createdBy: "me" }, theirs)).toBe(false)
    expect(keep({ ...NO_FILTERS, statuses: ["error"] }, mine, "error")).toBe(true)
    expect(keep({ ...NO_FILTERS, statuses: ["error"] }, mine)).toBe(false)
    // Archived only when asked for, whatever the status filter says.
    expect(keep(NO_FILTERS, mine, "archived")).toBe(false)
    expect(keep({ ...NO_FILTERS, showArchived: true }, mine, "archived")).toBe(true)
    expect(keep({ ...NO_FILTERS, showArchived: true, statuses: ["error"] }, mine, "archived")).toBe(true)
  })
})

describe("relativeTime", () => {
  const now = Date.parse("2026-11-07T12:00:00Z")
  it("reads in the coarsest unit", () => {
    expect(relativeTime("2026-11-07T11:59:40Z", now)).toBe("now")
    expect(relativeTime("2026-11-07T11:55:00Z", now)).toBe("5m")
    expect(relativeTime("2026-11-07T06:00:00Z", now)).toBe("6h")
    expect(relativeTime("2026-11-04T12:00:00Z", now)).toBe("3d")
    expect(relativeTime("2026-10-24T12:00:00Z", now)).toBe("2w")
    expect(relativeTime("2024-11-07T12:00:00Z", now)).toBe("2y")
    expect(relativeTime("2026-11-07T11:00:00Z", null)).toBe("")
    expect(relativeTime("garbage", now)).toBe("")
  })
})
