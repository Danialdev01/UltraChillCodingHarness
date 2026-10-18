import { describe, expect, it } from "vitest"
import { mermaidStreamParser as parser } from "./mermaid-language"

/** The tokens of one line, as [text, style] pairs with whitespace dropped. */
function tokens(line: string): Array<[string, string | null]> {
  const state = parser.startState!(2)
  const out: Array<[string, string | null]> = []
  // A minimal StringStream: the parser only uses these members.
  const stream = {
    string: line, pos: 0, start: 0,
    eol() { return this.pos >= this.string.length },
    sol() { return this.pos === 0 },
    peek() { return this.string.charAt(this.pos) || undefined },
    next() { return this.pos < this.string.length ? this.string.charAt(this.pos++) : undefined },
    eat(match: string) { if (this.string.charAt(this.pos) === match) { this.pos++; return match } return undefined },
    eatSpace() { const s = this.pos; while (/\s/.test(this.string.charAt(this.pos))) this.pos++; return this.pos > s },
    skipToEnd() { this.pos = this.string.length },
    skipTo(ch: string) { const at = this.string.indexOf(ch, this.pos); if (at > -1) { this.pos = at; return true } return false },
    match(pattern: string | RegExp) {
      if (typeof pattern === "string") { if (this.string.startsWith(pattern, this.pos)) { this.pos += pattern.length; return true } return null }
      const m = this.string.slice(this.pos).match(pattern)
      if (m && m.index === 0) { this.pos += m[0].length; return m }
      return null
    },
    current() { return this.string.slice(this.start, this.pos) },
  }
  while (!stream.eol()) {
    stream.start = stream.pos
    const style = parser.token(stream as never, state as never)
    const text = stream.current()
    if (text.trim()) out.push([text, style])
  }
  return out
}

describe("mermaid highlighting", () => {
  it("tells the diagram type, arrows, labels and names apart", () => {
    expect(tokens("flowchart LR")).toEqual([["flowchart", "typeName"], ["LR", "keyword"]])
    expect(tokens('web["Web app"] -->|HTTP| api')).toEqual([
      ["web", "variableName"], ["[", "bracket"], ['"Web app"', "string"], ["]", "bracket"],
      ["-->", "operator"], ["|HTTP|", "string"], ["api", "variableName"],
    ])
  })

  it("reads an ER relation as an arrow, not a label", () => {
    expect(tokens("users ||--o{ posts : writes").slice(0, 3)).toEqual([
      ["users", "variableName"], ["||--o{", "operator"], ["posts", "variableName"],
    ])
  })

  it("colours a comment to the end of the line", () => {
    expect(tokens("  %% from routes/web.php -->")).toEqual([["%% from routes/web.php -->", "comment"]])
  })
})
