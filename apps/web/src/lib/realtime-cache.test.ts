import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DomainEvent } from "@ucch/protocol"

import { BURST_MS, HERD_JITTER_MS, HERD_MS, cacheEffect, cacheSink, prefixOf } from "./realtime-cache"

const P = "33333333-3333-3333-3333-333333333333"
const ev = (e: object) => e as DomainEvent

describe("cacheEffect", () => {
  it("refreshes the shell's lists when a workspace's projects change", () => {
    const effect = cacheEffect(ev({ type: "resource.changed", projectId: null, resource: "projects" }))
    expect(effect.invalidate.map(prefixOf)).toContainEqual(["bootstrap"])
    // A rename: the open project page shows the new name.
    expect(effect.invalidate).toContainEqual(["project"])
  })

  it("turns settings changes into invalidations, not page renders", () => {
    const account = cacheEffect(ev({ type: "resource.changed", projectId: null, resource: "account_settings" }))
    expect(account).toEqual({ invalidate: [["bootstrap", null]] })
    const project = cacheEffect(ev({ type: "resource.changed", projectId: P, resource: "project_settings" }))
    expect(project.invalidate.map(prefixOf)).toEqual([["tasks"], ["bootstrap"], ["project"]])
  })

  it("maps each domain's events to its own cache family", () => {
    expect(cacheEffect(ev({ type: "task.changed", projectId: P })).invalidate).toEqual([["tasks"]])
    expect(cacheEffect(ev({ type: "timeline.changed", projectId: P })).invalidate).toEqual([["timeline"]])
    expect(cacheEffect(ev({ type: "note.changed", projectId: P })).invalidate).toEqual([["notes"]])
    expect(cacheEffect(ev({ type: "file.changed", projectId: P })).invalidate).toEqual([["files"], ["git"]])
    expect(cacheEffect(ev({ type: "thread.created", projectId: P })).invalidate).toEqual([["sessions"]])
    expect(cacheEffect(ev({ type: "resource.changed", projectId: null, resource: "workspace_members" })).invalidate).toContainEqual(["members"])
  })

  it("leaves streams alone", () => {
    expect(cacheEffect(ev({ type: "agent.text_delta", projectId: P })).invalidate).toEqual([])
  })
})

describe("the realtime bridge", () => {
  it("never renders the page again: no router.refresh in lib/realtime*", () => {
    const files = readdirSync(__dirname).filter((f) => /^realtime.*\.tsx?$/.test(f) && !f.includes(".test."))
    expect(files).toContain("realtime.tsx")
    for (const file of files) expect(readFileSync(join(__dirname, file), "utf8")).not.toMatch(/\.refresh\(/)
  })
})

describe("turn edges", () => {
  it("defer the bootstrap refetch and refresh the sessions lists at once", () => {
    for (const type of ["thread.created", "agent.turn_completed", "agent.turn_failed"]) {
      const effect = cacheEffect(ev({ type, projectId: P }))
      expect(effect.invalidate).toEqual([["sessions"]])
      expect(effect.deferred?.map(prefixOf)).toEqual([["bootstrap"]])
    }
  })
})

describe("cacheSink", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const completed = cacheEffect(ev({ type: "agent.turn_completed", projectId: P }))
  const bootstrapCalls = (invalidate: ReturnType<typeof vi.fn>) =>
    invalidate.mock.calls.filter(([key]) => (key as string[])[0] === "bootstrap").length

  it("invalidates a burst's keys once, after it goes quiet", () => {
    const invalidate = vi.fn()
    const sink = cacheSink(invalidate)
    sink.push(cacheEffect(ev({ type: "task.changed", projectId: P })))
    vi.advanceTimersByTime(BURST_MS - 50)
    sink.push(cacheEffect(ev({ type: "task.changed", projectId: P })))
    vi.advanceTimersByTime(BURST_MS - 50)
    expect(invalidate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(invalidate.mock.calls).toEqual([[["tasks"]]])
    sink.dispose()
  })

  it("refetches the bootstrap once per window under a steady stream of turn ends", () => {
    const invalidate = vi.fn()
    const sink = cacheSink(invalidate, () => 0.5)
    const window = HERD_MS + 0.5 * HERD_JITTER_MS
    // 50 turns ending 200 ms apart: ten seconds of them.
    for (let i = 0; i < 50; i++) {
      sink.push(completed)
      vi.advanceTimersByTime(200)
    }
    vi.advanceTimersByTime(window)
    // Never more often than once per window; the stream does not starve it.
    expect(bootstrapCalls(invalidate)).toBeGreaterThanOrEqual(2)
    expect(bootstrapCalls(invalidate)).toBeLessThanOrEqual(Math.ceil((50 * 200 + window) / HERD_MS))
    sink.dispose()
  })

  it("waits at least HERD_MS and at most HERD_MS + HERD_JITTER_MS", () => {
    for (const r of [0, 0.999]) {
      const invalidate = vi.fn()
      const sink = cacheSink(invalidate, () => r)
      sink.push(completed)
      vi.advanceTimersByTime(HERD_MS - 1)
      expect(bootstrapCalls(invalidate)).toBe(0)
      vi.advanceTimersByTime(HERD_JITTER_MS + 1)
      expect(bootstrapCalls(invalidate)).toBe(1)
      sink.dispose()
    }
  })

  it("drops a deferred key that a burst already refetched", () => {
    const invalidate = vi.fn()
    const sink = cacheSink(invalidate)
    sink.push(completed)
    sink.push(cacheEffect(ev({ type: "resource.changed", projectId: null, resource: "projects" })))
    vi.advanceTimersByTime(HERD_MS + HERD_JITTER_MS)
    expect(bootstrapCalls(invalidate)).toBe(1)
    sink.dispose()
  })
})
