import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { DomainEvent } from "@ucch/protocol"

import { cacheEffect, prefixOf } from "./realtime-cache"

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
    expect(cacheEffect(ev({ type: "thread.created", projectId: P })).invalidate.map(prefixOf)).toContainEqual(["sessions"])
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
