import { describe, expect, it } from "vitest"

import { planIndent, planLineMove, planTextShift, visualRanges, type Range } from "./line-moves"

const LINES = ["one", "two", "three", "four"]

/** Applies a plan the way the editor does, for readable assertions. */
function apply(lines: readonly string[], plan: ReturnType<typeof planLineMove>) {
  if (!plan) return [...lines]
  return [...lines.slice(0, plan.from), ...plan.text.split("\n"), ...lines.slice(plan.to + 1)]
}

describe("planLineMove", () => {
  it("moves a single line down", () => {
    const plan = planLineMove(LINES, 1, 1, 1)!
    expect(apply(LINES, plan)).toEqual(["one", "three", "two", "four"])
    expect([plan.blockFrom, plan.blockTo]).toEqual([2, 2])
  })

  it("moves a single line up", () => {
    const plan = planLineMove(LINES, 2, 2, -1)!
    expect(apply(LINES, plan)).toEqual(["one", "three", "two", "four"])
    expect([plan.blockFrom, plan.blockTo]).toEqual([1, 1])
  })

  it("moves a block of lines down, keeping their order", () => {
    const plan = planLineMove(LINES, 0, 1, 1)!
    expect(apply(LINES, plan)).toEqual(["three", "one", "two", "four"])
    expect([plan.blockFrom, plan.blockTo]).toEqual([1, 2])
  })

  it("moves a block of lines up, keeping their order", () => {
    const plan = planLineMove(LINES, 2, 3, -1)!
    expect(apply(LINES, plan)).toEqual(["one", "three", "four", "two"])
    expect([plan.blockFrom, plan.blockTo]).toEqual([1, 2])
  })

  it("rewrites only the lines that change", () => {
    const plan = planLineMove(LINES, 1, 1, 1)!
    expect([plan.from, plan.to]).toEqual([1, 2])
    expect(plan.text).toBe("three\ntwo")
  })

  it("refuses to move past either end", () => {
    expect(planLineMove(LINES, 0, 0, -1)).toBeNull()
    expect(planLineMove(LINES, 3, 3, 1)).toBeNull()
    expect(planLineMove(LINES, 0, 3, 1)).toBeNull()
    expect(planLineMove(LINES, 0, 3, -1)).toBeNull()
  })

  it("survives a round trip", () => {
    const down = planLineMove(LINES, 1, 2, 1)!
    const moved = apply(LINES, down)
    const back = planLineMove(moved, down.blockFrom, down.blockTo, -1)!
    expect(apply(moved, back)).toEqual(LINES)
  })

  it("preserves empty lines", () => {
    const lines = ["a", "", "b"]
    const plan = planLineMove(lines, 0, 0, 1)!
    expect(apply(lines, plan)).toEqual(["", "a", "b"])
  })
})

describe("visualRanges", () => {
  const width = (line: number) => LINES[line]!.length

  it("extends charwise selections over the character under the cursor", () => {
    const forward: Range = { anchor: { line: 0, ch: 1 }, head: { line: 1, ch: 2 } }
    expect(visualRanges(forward, "char", width).ranges).toEqual([
      { anchor: { line: 0, ch: 1 }, head: { line: 1, ch: 3 } },
    ])

    const backward: Range = { anchor: { line: 1, ch: 2 }, head: { line: 0, ch: 1 } }
    expect(visualRanges(backward, "char", width).ranges).toEqual([
      { anchor: { line: 1, ch: 3 }, head: { line: 0, ch: 1 } },
    ])
  })

  it("snaps linewise selections to whole lines, either direction", () => {
    const down: Range = { anchor: { line: 0, ch: 2 }, head: { line: 2, ch: 1 } }
    expect(visualRanges(down, "line", width).ranges).toEqual([
      { anchor: { line: 0, ch: 0 }, head: { line: 2, ch: 5 } },
    ])

    const up: Range = { anchor: { line: 2, ch: 1 }, head: { line: 0, ch: 2 } }
    expect(visualRanges(up, "line", width).ranges).toEqual([
      { anchor: { line: 2, ch: 5 }, head: { line: 0, ch: 0 } },
    ])
  })

  it("gives blockwise selections one range per line", () => {
    const sel: Range = { anchor: { line: 0, ch: 1 }, head: { line: 2, ch: 2 } }
    const { ranges, primary } = visualRanges(sel, "block", width)
    expect(ranges).toHaveLength(3)
    expect(ranges[0]).toEqual({ anchor: { line: 0, ch: 1 }, head: { line: 0, ch: 3 } })
    expect(ranges[2]).toEqual({ anchor: { line: 2, ch: 1 }, head: { line: 2, ch: 3 } })
    // The head is on the bottom line, so that is the primary range.
    expect(primary).toBe(2)
  })
})

describe("planIndent", () => {
  const UNIT = "  "

  it("indents every line in the range", () => {
    const lines = ["a", "b", "c"]
    const plan = planIndent(lines, 0, 1, 1, UNIT)!
    expect(plan.text).toBe("  a\n  b")
    expect(plan.shifts).toEqual([2, 2])
    expect([plan.from, plan.to]).toEqual([0, 1])
  })

  it("leaves blank lines alone when indenting", () => {
    const plan = planIndent(["a", "", "b"], 0, 2, 1, UNIT)!
    expect(plan.text).toBe("  a\n\n  b")
    expect(plan.shifts).toEqual([2, 0, 2])
  })

  it("outdents by one unit", () => {
    const plan = planIndent(["    a", "  b"], 0, 1, -1, UNIT)!
    expect(plan.text).toBe("  a\nb")
    expect(plan.shifts).toEqual([-2, -2])
  })

  it("outdents only the whitespace that is there", () => {
    const plan = planIndent([" a", "b"], 0, 1, -1, UNIT)!
    expect(plan.text).toBe("a\nb")
    expect(plan.shifts).toEqual([-1, 0])
  })

  it("treats a leading tab as one unit", () => {
    const plan = planIndent(["\ta"], 0, 0, -1, UNIT)!
    expect(plan.text).toBe("a")
    expect(plan.shifts).toEqual([-1])
  })

  it("does nothing when there is no indentation to remove", () => {
    expect(planIndent(["a", "b"], 0, 1, -1, UNIT)).toBeNull()
  })

  it("survives a round trip", () => {
    const lines = ["a", "  b"]
    const out = planIndent(lines, 0, 1, 1, UNIT)!.text.split("\n")
    expect(planIndent(out, 0, 1, -1, UNIT)!.text.split("\n")).toEqual(lines)
  })
})

describe("planTextShift", () => {
  /** Applies a shift and marks where the selection ended up. */
  function apply(doc: string, from: number, to: number, delta: number) {
    const plan = planTextShift(doc, from, to, delta)
    if (!plan) return null
    const next = doc.slice(0, plan.from) + plan.text + doc.slice(plan.to)
    return next.slice(0, plan.selFrom) + "[" + next.slice(plan.selFrom, plan.selTo) + "]" + next.slice(plan.selTo)
  }

  it("swaps the selection with the character to its right", () => {
    expect(apply("abcdefghi", 3, 6, 1)).toBe("abcg[def]hi")
  })

  it("swaps the selection with the character to its left", () => {
    expect(apply("abcdefghi", 3, 6, -1)).toBe("ab[def]cghi")
  })

  it("moves a single character", () => {
    expect(apply("ab", 0, 1, 1)).toBe("b[a]")
  })

  it("stops at the end of the line rather than crossing it", () => {
    expect(planTextShift("abc\ndef", 1, 3, 1)).toBeNull()
  })

  it("stops at the start of the line rather than crossing it", () => {
    expect(planTextShift("abc\ndef", 4, 6, -1)).toBeNull()
  })

  it("stops at the ends of the document", () => {
    expect(planTextShift("abc", 0, 3, 1)).toBeNull()
    expect(planTextShift("abc", 0, 3, -1)).toBeNull()
  })

  it("survives a round trip", () => {
    const doc = "const foo = bar"
    const right = planTextShift(doc, 6, 9, 1)!
    const moved = doc.slice(0, right.from) + right.text + doc.slice(right.to)
    const back = planTextShift(moved, right.selFrom, right.selTo, -1)!
    expect(moved.slice(0, back.from) + back.text + moved.slice(back.to)).toBe(doc)
  })
})
