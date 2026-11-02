import { describe, expect, it } from "vitest"
import type { ReviewFinding } from "@ucch/protocol"

import { findingPlace, findingsMessage, findingsOn, reviewApplies, reviewSubject } from "./review-api"

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  priority: "P0",
  confidence: 0.9,
  title: "div multiplies",
  body: "`a * b` should be `a / b`.",
  file: "math.ts",
  startLine: 2,
  endLine: 2,
  ...over,
})

describe("review-api", () => {
  it("says what a review looked at", () => {
    expect(reviewSubject({ scope: "uncommitted", ref: null })).toBe("the uncommitted changes")
    expect(reviewSubject({ scope: "branch", ref: null })).toBe("the branch")
    expect(reviewSubject({ scope: "branch", ref: "main" })).toBe("the branch since main")
    expect(reviewSubject({ scope: "commit", ref: "1a2b3c4d5e6f" })).toBe("commit 1a2b3c4")
  })

  it("draws a commit's review on that commit only, the others on the changes", () => {
    expect(reviewApplies({ scope: "commit", ref: "1a2b3c4d" }, { kind: "commit", sha: "1a2b3c4d5e6f" })).toBe(true)
    expect(reviewApplies({ scope: "commit", ref: "1a2b3c4d" }, { kind: "commit", sha: "ffff" })).toBe(false)
    expect(reviewApplies({ scope: "commit", ref: "1a2b3c4d" }, { kind: "change" })).toBe(false)
    expect(reviewApplies({ scope: "uncommitted", ref: null }, { kind: "change" })).toBe(true)
    expect(reviewApplies({ scope: "branch", ref: null }, { kind: "commit", sha: "1a2b" })).toBe(false)
  })

  it("picks a file's findings and names their place", () => {
    const review = { findings: [finding(), finding({ file: "other.ts" })] }
    expect(findingsOn(review, "math.ts")).toEqual([finding()])
    expect(findingsOn(null, "math.ts")).toEqual([])
    expect(findingPlace(finding())).toBe("math.ts:2")
    expect(findingPlace(finding({ endLine: 5 }))).toBe("math.ts:2-5")
    expect(findingPlace(finding({ startLine: 0, endLine: 0 }))).toBe("math.ts")
  })

  it("writes the message Send to agent posts", () => {
    const review = { scope: "uncommitted" as const, ref: null, verdict: { verdict: "incorrect" as const, explanation: "", confidence: 0.9 } }
    expect(findingsMessage(review, [finding(), finding({ priority: "P2", title: "naming", body: "Call it quotient.\n\nIt divides.", startLine: 1, endLine: 1 })])).toBe(
      [
        "A code review of the uncommitted changes found these 2 findings. The reviewer judged it incorrect. Please fix them, or say why not.",
        "",
        "1. [P0] div multiplies (math.ts:2)",
        "   `a * b` should be `a / b`.",
        "2. [P2] naming (math.ts:1)",
        "   Call it quotient.",
        "   It divides.",
      ].join("\n"),
    )
    expect(findingsMessage({ scope: "commit", ref: "abcdef12", verdict: null }, [finding()]).split("\n")[0]).toBe(
      "A code review of commit abcdef1 found this. Please fix it, or say why not.",
    )
  })
})
