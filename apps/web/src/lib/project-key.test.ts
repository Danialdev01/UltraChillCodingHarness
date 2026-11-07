import { describe, expect, it } from "vitest"

import { newKeyProblem } from "./project-key"

describe("newKeyProblem", () => {
  it("wants a long enough key, typed twice the same", () => {
    expect(newKeyProblem("short", "short")).toMatch(/at least 8/)
    expect(newKeyProblem("long enough", "long enougj")).toMatch(/do not match/)
    expect(newKeyProblem("long enough", "long enough")).toBeNull()
  })
})
