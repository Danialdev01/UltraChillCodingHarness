import { describe, expect, it } from "vitest"

import { PROJECT_PAGES, SECTIONS, SETTINGS_PAGES, sectionHref, settingsPageHref } from "./sections"
import { SKELETON_ONLY, warmupHrefs } from "./warmup"

const HASH = "rdhm15c4hl8o"
const OTHER = "abcdefghijkl"
const WS = "wkspc0hash00"
const PROJECTS = { hash: WS, kind: "project" } as const
const SESSIONS = { hash: WS, kind: "session" } as const

describe("warmupHrefs", () => {
  it("covers every section and every Settings page", () => {
    const hrefs = warmupHrefs(`/${WS}`, PROJECTS, [])
    for (const s of SECTIONS.slice(1)) expect(hrefs).toContain(sectionHref(s, WS))
    for (const p of SETTINGS_PAGES) expect(hrefs).toContain(settingsPageHref(p.id))
  })

  it("leaves out the page in view and the /setting redirect stub", () => {
    const hrefs = warmupHrefs(`/${WS}`, PROJECTS, [])
    expect(hrefs).not.toContain(`/${WS}`)
    expect(hrefs).not.toContain("/setting")
  })

  it("warms the project in view, every page of it", () => {
    const hrefs = warmupHrefs(`/${WS}/p/${HASH}/tasks`, PROJECTS, [OTHER])
    for (const p of PROJECT_PAGES.filter((p) => p.id !== "tasks")) expect(hrefs).toContain(`/${WS}/p/${HASH}/${p.id}`)
    expect(hrefs).not.toContain(`/${WS}/p/${HASH}/tasks`)
    expect(hrefs.some((h) => h.includes(OTHER))).toBe(false)
  })

  it("off a project, warms the first one listed", () => {
    expect(warmupHrefs(`/${WS}/code`, PROJECTS, [OTHER, HASH])).toContain(`/${WS}/p/${OTHER}/tasks`)
  })

  it("off a project, warms the three at the top of the list and no more", () => {
    const four = [OTHER, HASH, "aaaaaaaaaaaa", "bbbbbbbbbbbb"]
    const hrefs = warmupHrefs(`/${WS}/code`, PROJECTS, four)
    for (const hash of four.slice(0, 3)) expect(hrefs).toContain(`/${WS}/p/${hash}/tasks`)
    expect(hrefs.some((h) => h.includes("bbbbbbbbbbbb"))).toBe(false)
  })

  it("in a session workspace, warms the session rather than project pages", () => {
    const hrefs = warmupHrefs(`/${WS}`, SESSIONS, [HASH])
    expect(hrefs).toContain(`/${WS}/s/${HASH}`)
    expect(hrefs.some((h) => h.includes("/p/"))).toBe(false)
  })

  it("without a workspace, warms only the global pages", () => {
    const hrefs = warmupHrefs("/", null, [HASH])
    expect(hrefs.every((h) => h === "/" || h.startsWith("/setting"))).toBe(true)
  })

  it("has no duplicates", () => {
    const hrefs = warmupHrefs(`/${WS}/code`, PROJECTS, [HASH])
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it("only skeleton-prefetches pages that are listed", () => {
    for (const href of SKELETON_ONLY) expect(warmupHrefs(`/${WS}`, PROJECTS, [])).toContain(href)
  })
})
