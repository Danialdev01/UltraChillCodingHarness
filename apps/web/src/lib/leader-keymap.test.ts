import { describe, expect, it } from "vitest"

import { leaderBindings, leaderChildren } from "./leader-keymap"

describe("leaderBindings", () => {
  it("spells every sequence the way the vim layer does", () => {
    const keys = leaderBindings().map((b) => b.keys)
    expect(keys).toContain("<Space>ss")
    expect(keys).toContain("<Space>sb")
    expect(keys).toContain("<Space>.")
    expect(keys).toContain("<Space>fs")
    expect(keys).toContain("<Space>b]")
  })

  it("has no sequence bound twice", () => {
    const keys = leaderBindings().map((b) => b.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("has no prefix that is also a leaf", () => {
    const keys = leaderBindings().map((b) => b.keys)
    for (const a of keys) {
      for (const b of keys) {
        if (a !== b) expect(b.startsWith(a)).toBe(false)
      }
    }
  })

  it("routes the request that started this to the buffer search", () => {
    expect(leaderBindings().find((b) => b.keys === "<Space>ss")?.command).toBe("search-buffer")
  })
})

describe("leaderChildren", () => {
  it("lists the top-level menus after the leader alone", () => {
    const rows = leaderChildren("<Space>")!
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(byKey["s"]).toEqual({ key: "s", desc: "search", prefix: true })
    expect(byKey["b"]?.prefix).toBe(true)
    expect(byKey["f"]?.prefix).toBe(true)
    expect(byKey["."]).toEqual({ key: ".", desc: "Find file", prefix: false })
    expect(Object.keys(byKey).sort()).toEqual([",", ".", "/", ":", "b", "f", "s"])
  })

  it("narrows to a submenu", () => {
    const rows = leaderChildren("<Space>s")!
    expect(rows.map((r) => r.key).sort()).toEqual(["b", "p", "s"])
    expect(rows.every((r) => !r.prefix)).toBe(true)
  })

  it("is null for anything that is not a leader prefix", () => {
    expect(leaderChildren("")).toBeNull()
    expect(leaderChildren("d")).toBeNull()
    expect(leaderChildren("2")).toBeNull()
    expect(leaderChildren("<Space>ss")).toBeNull()
    expect(leaderChildren("<Space>z")).toBeNull()
  })
})
