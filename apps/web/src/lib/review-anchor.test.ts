import { describe, expect, it } from "vitest"
import type { ReviewFinding } from "@ucch/protocol"

import { parsePatch } from "./git-diff"
import { anchorFindings } from "./review-anchor"

const finding = (startLine: number, endLine = startLine, title = `at ${startLine}`): ReviewFinding => ({
  priority: "P1",
  confidence: 0.5,
  title,
  body: "",
  file: "math.ts",
  startLine,
  endLine,
})

const PATCH = [
  "diff --git a/math.ts b/math.ts",
  "--- a/math.ts",
  "+++ b/math.ts",
  "@@ -1,3 +1,3 @@",
  " export const add = (a: number, b: number) => a + b;",
  "-export const div = (a: number, b: number) => a / b;",
  "+export const div = (a: number, b: number) => a * b;",
  " export const one = 1;",
  "",
].join("\n")

describe("anchorFindings", () => {
  const [file] = parsePatch(PATCH)

  it("pins a finding after its line on the new side and flags its range", () => {
    // Lines of the hunk: 0 context (1), 1 deleted (old 2), 2 added (new 2), 3 context (3).
    const anchors = anchorFindings(file!, [finding(2), finding(1, 3, "range")])
    expect([...anchors.after]).toEqual([
      ["0:2", [finding(2)]],
      ["0:3", [finding(1, 3, "range")]],
    ])
    expect([...anchors.flagged].sort()).toEqual(["0:0", "0:2", "0:3"])
    expect(anchors.outside).toEqual([])
  })

  it("puts a finding the diff does not show, or on no line, above the file", () => {
    const anchors = anchorFindings(file!, [finding(40), finding(0)])
    expect(anchors.outside.map((f) => f.startLine)).toEqual([40, 0])
    expect(anchors.after.size).toBe(0)
  })

  it("numbers a deleted file's lines as the old file had them", () => {
    const [gone] = parsePatch(["diff --git a/x.ts b/x.ts", "deleted file mode 100644", "--- a/x.ts", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b", ""].join("\n"))
    expect([...anchorFindings(gone!, [finding(2)]).after.keys()]).toEqual(["0:1"])
  })
})
