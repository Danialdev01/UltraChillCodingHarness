/**
 * Moving whole lines around, and rebuilding the visual selection that follows
 * them.
 *
 * Pure and free of both CodeMirror and the vim layer, so the fiddly parts --
 * which lines get rewritten, where the block lands, where the selection ends
 * up in each visual sub-mode -- are testable without a browser. The editor
 * turns the result into a transaction; nothing here knows how.
 */

/** A position in the document, 0-based on both axes, as vim uses. */
export interface Pos {
  line: number
  ch: number
}

export interface LineMove {
  /** The 0-based inclusive line range to rewrite. */
  from: number
  to: number
  /** What to put there, newline-joined. */
  text: string
  /** Where the moved block ends up, 0-based inclusive. */
  blockFrom: number
  blockTo: number
}

/**
 * Swaps the lines `from..to` with the neighbour `delta` away.
 *
 * Returns null when there is no neighbour to swap with, so the caller can
 * leave the document -- and the selection -- exactly as it was rather than
 * writing an edit that changes nothing.
 *
 * Only the two-line-or-so span that actually changes is rewritten, rather
 * than the whole document, so undo steps stay small and the edit does not
 * fight anything else holding a position further down the file.
 */
export function planLineMove(
  lines: readonly string[],
  from: number,
  to: number,
  delta: number,
): LineMove | null {
  if (delta === 0) return null
  if (delta < 0 && from === 0) return null
  if (delta > 0 && to === lines.length - 1) return null

  const block = lines.slice(from, to + 1)

  if (delta > 0) {
    const neighbour = lines[to + 1]!
    return {
      from,
      to: to + 1,
      text: [neighbour, ...block].join("\n"),
      blockFrom: from + 1,
      blockTo: to + 1,
    }
  }

  const neighbour = lines[from - 1]!
  return {
    from: from - 1,
    to,
    text: [...block, neighbour].join("\n"),
    blockFrom: from - 1,
    blockTo: to - 1,
  }
}

export interface IndentPlan {
  /** The 0-based inclusive line range to rewrite. */
  from: number
  to: number
  /** What to put there, newline-joined. */
  text: string
  /** How much each line gained (+) or lost (-), in order from `from`. */
  shifts: number[]
}

/**
 * Indents or outdents the lines `from..to` by one `unit`.
 *
 * Returns null when an outdent would do nothing, so the caller can leave the
 * document alone rather than pushing an empty edit onto the undo stack.
 *
 * Blank lines are left alone when indenting, the way vim's `>` does: adding
 * whitespace to an empty line only leaves trailing space behind.
 */
export function planIndent(
  lines: readonly string[],
  from: number,
  to: number,
  delta: number,
  unit: string,
): IndentPlan | null {
  const span = lines.slice(from, to + 1)
  const shifts: number[] = []

  const next = span.map((line) => {
    if (delta > 0) {
      if (line.trim() === "") {
        shifts.push(0)
        return line
      }
      shifts.push(unit.length)
      return unit + line
    }

    // Outdent: one tab, or up to `unit.length` spaces -- whichever the line
    // actually starts with.
    if (line.startsWith("\t")) {
      shifts.push(-1)
      return line.slice(1)
    }
    let removed = 0
    while (removed < unit.length && line[removed] === " ") removed++
    // Negating zero gives -0, which is numerically fine but reads oddly in a
    // list of shifts and trips strict comparison in tests.
    shifts.push(removed === 0 ? 0 : -removed)
    return line.slice(removed)
  })

  if (shifts.every((n) => n === 0)) return null
  return { from, to, text: next.join("\n"), shifts }
}

export interface TextShift {
  /** Region of the document to rewrite, in character offsets. */
  from: number
  to: number
  text: string
  /** Where the selection lands afterwards, as an offset range. */
  selFrom: number
  selTo: number
}

/**
 * Slides the selected text one character sideways, swapping it with the
 * character it displaces.
 *
 * This is what "move the selection" means when actual text is selected rather
 * than whole lines: `abc[def]ghi` moved right is `abcg[def]hi`. Newlines are
 * a wall -- a selection stops at the end of its line instead of being dragged
 * onto the next one, which is never what was meant.
 *
 * `to` is exclusive. Returns null when there is nowhere to go.
 */
export function planTextShift(
  doc: string,
  from: number,
  to: number,
  delta: number,
): TextShift | null {
  if (delta > 0) {
    const displaced = doc[to]
    if (displaced === undefined || displaced === "\n") return null
    return {
      from,
      to: to + 1,
      text: displaced + doc.slice(from, to),
      selFrom: from + 1,
      selTo: to + 1,
    }
  }

  const displaced = doc[from - 1]
  if (from === 0 || displaced === undefined || displaced === "\n") return null
  return {
    from: from - 1,
    to,
    text: doc.slice(from, to) + displaced,
    selFrom: from - 1,
    selTo: to - 1,
  }
}

export type VisualMode = "char" | "line" | "block"

export interface Range {
  anchor: Pos
  head: Pos
}

function isBefore(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.ch < b.ch)
}

/**
 * The editor ranges that draw a vim visual selection.
 *
 * Mirrors the vim layer's own `makeCmSelection`, which is internal: vim keeps
 * the selection as a single anchor/head pair plus a sub-mode, and only turns
 * it into concrete ranges when it paints. Moving lines out from under a
 * selection means repainting it, so that last step has to be reproduced here.
 *
 * `lineLength` is passed in rather than a document, so this stays pure.
 */
export function visualRanges(
  sel: Range,
  mode: VisualMode,
  lineLength: (line: number) => number,
): { ranges: Range[]; primary: number } {
  const head = { ...sel.head }
  const anchor = { ...sel.anchor }

  if (mode === "char") {
    // Vim's visual selection includes the character under the cursor, so
    // whichever end is trailing extends by one column.
    const headForward = !isBefore(sel.head, sel.anchor)
    return {
      ranges: [
        {
          anchor: { ...anchor, ch: anchor.ch + (headForward ? 0 : 1) },
          head: { ...head, ch: head.ch + (headForward ? 1 : 0) },
        },
      ],
      primary: 0,
    }
  }

  if (mode === "line") {
    if (!isBefore(sel.head, sel.anchor)) {
      anchor.ch = 0
      head.ch = lineLength(head.line)
    } else {
      head.ch = 0
      anchor.ch = lineLength(anchor.line)
    }
    return { ranges: [{ anchor, head }], primary: 0 }
  }

  // Block: one range per line, between the two columns.
  const top = Math.min(anchor.line, head.line)
  const bottom = Math.max(anchor.line, head.line)
  let fromCh = anchor.ch
  let toCh = head.ch
  if (fromCh < toCh) toCh += 1
  else fromCh += 1

  const ranges: Range[] = []
  for (let line = top; line <= bottom; line++) {
    ranges.push({ anchor: { line, ch: fromCh }, head: { line, ch: toCh } })
  }
  return { ranges, primary: head.line === top ? 0 : ranges.length - 1 }
}
