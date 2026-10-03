import { describe, expect, it } from "vitest"

import { matchLines } from "./line-search"

const TEXT = ["const foo = 1", "", "function bar(foo) {", "  return Foo + foo", "}"].join("\n")

describe("matchLines", () => {
  it("numbers lines from one and skips blank ones", () => {
    expect(matchLines(TEXT, "").map((m) => m.line)).toEqual([1, 3, 4, 5])
  })

  it("keeps the line text as written", () => {
    expect(matchLines(TEXT, "return")).toEqual([{ line: 4, text: "  return Foo + foo" }])
  })

  it("needs every word, in any order", () => {
    expect(matchLines(TEXT, "foo bar").map((m) => m.line)).toEqual([3])
    expect(matchLines(TEXT, "bar foo").map((m) => m.line)).toEqual([3])
    expect(matchLines(TEXT, "bar baz")).toEqual([])
  })

  it("ignores case until the query has a capital", () => {
    expect(matchLines(TEXT, "foo").map((m) => m.line)).toEqual([1, 3, 4])
    expect(matchLines(TEXT, "Foo").map((m) => m.line)).toEqual([4])
  })

  it("stops at the limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    expect(matchLines(many, "line", 10)).toHaveLength(10)
    expect(matchLines(many, "line", 10).at(-1)?.line).toBe(10)
  })
})
