/**
 * The buffer search behind `SPC s s`: which lines of a file match a query.
 *
 * Matching is the way Doom's consult-line (via orderless) does it rather than
 * a fuzzy score: the query is words, and a line matches when it contains
 * every one of them, in any order. Fuzzy matching is right for picking one
 * file name out of a tree; over source lines it ranks `const x = foo(bar)` as
 * a match for `cxfb`, which is never what was wanted.
 *
 * Case follows the query, as vim's `smartcase` and consult have it: all
 * lowercase is case-insensitive, a capital anywhere makes it exact.
 */

export interface LineMatch {
  /** 1-based, as the gutter numbers it and as `revealInFile` wants it. */
  line: number
  text: string
}

export const DEFAULT_LINE_LIMIT = 300

export function matchLines(text: string, query: string, limit = DEFAULT_LINE_LIMIT): LineMatch[] {
  const terms = query.split(/\s+/).filter(Boolean)
  const exact = /[A-Z]/.test(query)
  const fold = (s: string) => (exact ? s : s.toLowerCase())
  const needles = terms.map(fold)

  const out: LineMatch[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    const line = lines[i]!
    // Blank lines match every query and are worth nothing to jump to.
    if (line.trim() === "") continue
    const hay = fold(line)
    if (needles.every((needle) => hay.includes(needle))) out.push({ line: i + 1, text: line })
  }
  return out
}
