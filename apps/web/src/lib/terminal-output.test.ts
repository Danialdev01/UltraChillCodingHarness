import { describe, expect, it } from "vitest"
import { EMPTY_OUTPUT, appendOutput } from "./terminal-output"

describe("appendOutput", () => {
  it("keeps counting after the buffer is full", () => {
    let output = EMPTY_OUTPUT
    for (let i = 0; i < 5; i++) output = appendOutput(output, [`c${i}`], 3)
    expect(output.chunks).toEqual(["c2", "c3", "c4"])
    // The bug this replaces: with a capped array, length sat at 3 forever
    // and the pane stopped writing anything new.
    expect(output.total).toBe(5)

    const next = appendOutput(output, ["c5"], 3)
    expect(next.total - output.total).toBe(1)
    expect(next.chunks.at(-1)).toBe("c5")
  })

  it("returns the same object when nothing arrived", () => {
    const output = appendOutput(EMPTY_OUTPUT, ["a"], 3)
    expect(appendOutput(output, [], 3)).toBe(output)
  })
})
