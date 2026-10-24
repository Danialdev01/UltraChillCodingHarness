import { TERMINAL_INPUT_MAX } from "@ucch/protocol"
import { describe, expect, it } from "vitest"

import { terminalPieces } from "./client"

describe("terminalPieces", () => {
  it("sends a keystroke, or anything that fits, as it is", () => {
    expect(terminalPieces("a")).toEqual(["a"])
    expect(terminalPieces("")).toEqual([""])
    expect(terminalPieces("x".repeat(TERMINAL_INPUT_MAX))).toHaveLength(1)
  })

  it("splits a long paste into pieces a frame may carry, losing nothing", () => {
    const paste = "y".repeat(TERMINAL_INPUT_MAX * 2 + 5)
    const pieces = terminalPieces(paste)
    expect(pieces.map((p) => p.length)).toEqual([TERMINAL_INPUT_MAX, TERMINAL_INPUT_MAX, 5])
    expect(pieces.join("")).toBe(paste)
  })

  it("never cuts a character in two", () => {
    // "😀" is two UTF-16 units; four units from the start is between them.
    const pieces = terminalPieces("abc😀de", 4)
    expect(pieces).toEqual(["abc", "😀de"])
    expect(pieces.join("")).toBe("abc😀de")
  })
})
