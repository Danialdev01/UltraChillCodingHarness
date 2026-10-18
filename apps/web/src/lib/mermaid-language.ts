import { LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language"

/**
 * Mermaid, coloured: enough of a grammar to tell the diagram's keywords,
 * arrows, labels and comments apart, which is what makes a long diagram
 * scannable. Not a parser -- Mermaid's own reports the errors, in the
 * preview -- so anything it does not recognise is simply left plain.
 */

/** The first word of a diagram, naming its type. */
const DIAGRAM_TYPES = new Set([
  "flowchart", "graph", "sequenceDiagram", "erDiagram", "classDiagram", "stateDiagram",
  "stateDiagram-v2", "gantt", "pie", "journey", "gitGraph", "mindmap", "timeline",
  "quadrantChart", "requirementDiagram", "C4Context", "sankey-beta", "xychart-beta", "block-beta",
])

/** Words that are syntax wherever they stand at the start of a statement. */
const KEYWORDS = new Set([
  "subgraph", "end", "direction", "classDef", "class", "style", "linkStyle", "click",
  "participant", "actor", "as", "loop", "alt", "else", "opt", "par", "and", "critical",
  "break", "rect", "note", "over", "left", "right", "of", "activate", "deactivate",
  "autonumber", "title", "section", "dateFormat", "state",
  "TB", "TD", "BT", "RL", "LR",
  "PK", "FK", "UK",
])

type State = { inString: boolean }

export const mermaidStreamParser: StreamParser<State> = {
  name: "mermaid",
  startState: () => ({ inString: false }),
  token(stream, state) {
    if (state.inString) {
      if (stream.skipTo('"')) {
        stream.next()
        state.inString = false
      } else {
        stream.skipToEnd()
      }
      return "string"
    }
    if (stream.eatSpace()) return null
    if (stream.match("%%")) {
      stream.skipToEnd()
      return "comment"
    }
    if (stream.eat('"')) {
      // To the closing quote, or on into the next line when there is none.
      if (stream.skipTo('"')) stream.next()
      else {
        stream.skipToEnd()
        state.inString = true
      }
      return "string"
    }
    // Edge labels: `-->|text|`. Only right after an arrow, so an ER
    // relation's `||--o{` or `|o--o|` is not taken for one.
    if (/[->=.]\s*$/.test(stream.string.slice(0, stream.pos)) && stream.match(/^\|[^|]+\|/)) return "string"
    // Arrows and ER cardinalities: `-->`, `-.->`, `==>`, `->>`, `||--o{`, ...
    if (stream.match(/^[<xo|}{]*(?:-{1,}|={2,}|\.{1,})[-.=]*[>xo|}{)]*(?![\w])/)) return "operator"
    if (stream.match(/^[[\](){}]+/)) return "bracket"
    if (stream.match(/^\d+(?:\.\d+)?\b/)) return "number"
    const word = stream.match(/^[\w$-]+/)
    if (word && Array.isArray(word)) {
      const text = word[0]
      if (stream.string.slice(0, stream.start).trim() === "" && DIAGRAM_TYPES.has(text)) return "typeName"
      if (KEYWORDS.has(text)) return "keyword"
      return "variableName"
    }
    stream.next()
    return null
  },
  languageData: { commentTokens: { line: "%%" } },
}

export function mermaid(): LanguageSupport {
  return new LanguageSupport(StreamLanguage.define(mermaidStreamParser))
}
