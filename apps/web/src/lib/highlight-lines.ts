import { highlightCode } from "@lezer/highlight"

import { languageFor } from "./languages"
import { syntaxTagHighlighter } from "./syntax-highlight"

/** One coloured run of a line; `cls` is empty for text with no role. */
export interface Token {
  text: string
  cls: string
}

/**
 * Colours a whole file's text, one token list per line.
 *
 * Parsed once rather than line by line so a comment or string that spans
 * lines is coloured as one thing, which is also why the diff view feeds it
 * a reconstructed side of the file rather than the hunks. A path with no
 * grammar comes back as plain lines rather than an error.
 */
export function highlightLines(code: string, path: string): Token[][] {
  const language = languageFor(path)
  const lines: Token[][] = [[]]
  if (!language) {
    return code.split("\n").map((text) => (text ? [{ text, cls: "" }] : []))
  }
  const tree = language.language.parser.parse(code)
  highlightCode(
    code,
    tree,
    syntaxTagHighlighter,
    (text, cls) => {
      // Tokens can span a newline when a construct does; keep lines separate.
      const parts = text.split("\n")
      parts.forEach((part, i) => {
        if (i > 0) lines.push([])
        if (part) lines[lines.length - 1]!.push({ text: part, cls })
      })
    },
    () => lines.push([]),
  )
  return lines
}
