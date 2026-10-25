import { describe, expect, it } from "vitest"

import { streamingCut } from "./streaming-markdown"

const split = (text: string) => {
  const cut = streamingCut(text)
  return [text.slice(0, cut), text.slice(cut)]
}

describe("streamingCut", () => {
  it("cuts before the newest paragraph", () => {
    expect(split("One.\n\nTwo.\n\nThree is still go")).toEqual(["One.\n\nTwo.\n\n", "Three is still go"])
  })

  it("has nothing to cut before the first blank line", () => {
    expect(streamingCut("A single paragraph, still")).toBe(0)
    expect(streamingCut("First line\nsecond line\n")).toBe(0)
  })

  it("never cuts inside a code fence", () => {
    const text = "Intro.\n\n```ts\nconst a = 1\n\nconst b = 2\n"
    expect(split(text)).toEqual(["Intro.\n\n", "```ts\nconst a = 1\n\nconst b = 2\n"])
    const closed = text + "```\n\nAfter.\n\nTail"
    expect(split(closed)[1]).toBe("Tail")
  })

  it("knows a fence closes only with its own kind, at least as long", () => {
    const text = "A.\n\n````\n```\n\nstill code\n````\n\nB.\n\nC"
    expect(split(text)[1]).toBe("C")
    const tilde = "A.\n\n~~~\n```\n\ninside\n"
    expect(split(tilde)).toEqual(["A.\n\n", "~~~\n```\n\ninside\n"])
  })

  it("waits for a line that starts a block of its own", () => {
    // A list item's second paragraph, indented: not a place to cut.
    expect(split("- one\n\n    more of one\n")).toEqual(["", "- one\n\n    more of one\n"])
    expect(split("- one\n\n    more of one\n\nNext")).toEqual(["- one\n\n    more of one\n\n", "Next"])
  })

  it("cuts at a line still being written once it has begun a block", () => {
    expect(streamingCut("Done.\n\nHalf")).toBe(7)
    expect(streamingCut("Done.\n\n  ")).toBe(0)
  })
})
