import { describe, expect, it } from "vitest"
import type { GitStatus } from "@ucch/protocol"
import { gitRepairPrompt } from "./git-repair"

describe("gitRepairPrompt", () => {
  it("passes the error and conflicted files to the session's repair request", () => {
    const status = {
      branch: "ucch/session-one", upstream: "origin/main", mergeInProgress: true, rebaseInProgress: false,
      files: [{ path: "src/example.ts", conflicted: true }, { path: "other.ts", conflicted: false }],
    } as GitStatus
    const prompt = gitRepairPrompt(status, "Automatic merge failed")
    expect(prompt).toContain("ucch/session-one")
    expect(prompt).toContain("origin/main")
    expect(prompt).toContain("Automatic merge failed")
    expect(prompt).toContain("Conflicted files:\nsrc/example.ts")
    expect(prompt).not.toContain("other.ts")
    expect(prompt).toContain("A merge is in progress")
    expect(prompt).toContain("do not discard work")
    expect(prompt).toContain("commit or push automatically")
  })
})
