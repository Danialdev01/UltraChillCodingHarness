/**
 * Reads unified diffs the way `git diff` prints them.
 *
 * Pure text in, structure out: the view decides how a hunk looks, this only
 * says where it starts and which side each line is on. Everything git puts
 * before the first `@@` -- `diff --git`, `index`, mode and rename lines -- is
 * read for the paths and otherwise skipped.
 */

export type DiffLineKind = "context" | "add" | "del"

export interface DiffLine {
  kind: DiffLineKind
  text: string
  /** Line number on the old side; absent on an added line. */
  oldNo?: number
  /** Line number on the new side; absent on a deleted line. */
  newNo?: number
  /** Set when git said `\ No newline at end of file` after this line. */
  noNewline?: boolean
}

export interface DiffHunk {
  /** The `@@ ... @@` line as printed, including any function context. */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffFile {
  /** Path on the old side, or null for a new file. */
  oldPath: string | null
  /** Path on the new side, or null for a deleted file. */
  newPath: string | null
  hunks: DiffHunk[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/

export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0

  const lines = patch.split("\n")
  // A trailing newline leaves one empty string that is not a line.
  if (lines[lines.length - 1] === "") lines.pop()

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      file = { oldPath: null, newPath: null, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) {
      // `git diff --no-index /dev/null x` and `diff-tree -p` both start
      // with a `diff` line, but be forgiving of a bare patch.
      file = { oldPath: null, newPath: null, hunks: [] }
      files.push(file)
    }
    if (hunk === null) {
      if (line.startsWith("--- ")) {
        file.oldPath = pathFrom(line.slice(4))
        continue
      }
      if (line.startsWith("+++ ")) {
        file.newPath = pathFrom(line.slice(4))
        continue
      }
      if (line.startsWith("rename from ")) {
        file.oldPath = line.slice("rename from ".length)
        continue
      }
      if (line.startsWith("rename to ")) {
        file.newPath = line.slice("rename to ".length)
        continue
      }
    }
    const header = HUNK.exec(line)
    if (header) {
      oldNo = Number(header[1])
      newNo = Number(header[3])
      hunk = {
        header: line,
        oldStart: oldNo,
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: newNo,
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    const marker = line[0]
    if (marker === "\\") {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
      continue
    }
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1), newNo: newNo++ })
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ })
    } else if (marker === " " || line === "") {
      hunk.lines.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    } else {
      // Something after the hunk that is not a line of it: the next file's
      // preamble in a multi-file patch without `diff --git` lines.
      hunk = null
    }
  }
  return files
}

/** `a/src/x.ts` -> `src/x.ts`; `/dev/null` -> null. Tabs end a quoted path. */
function pathFrom(raw: string): string | null {
  const path = raw.split("\t")[0]!
  if (path === "/dev/null") return null
  return path.replace(/^[ab]\//, "")
}

/**
 * The old and new sides of a file, rebuilt from its hunks.
 *
 * Only what the hunks cover: gaps between them are missing lines, and the
 * arrays are sparse where they are, indexed by line number. The highlighter
 * needs contiguous text, so the sides are returned as one string each along
 * with the mapping from a line number to its index in that string.
 */
export function sidesOf(file: DiffFile): {
  oldText: string
  newText: string
  oldIndex: Map<number, number>
  newIndex: Map<number, number>
} {
  const oldLines: string[] = []
  const newLines: string[] = []
  const oldIndex = new Map<number, number>()
  const newIndex = new Map<number, number>()
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.oldNo !== undefined) {
        oldIndex.set(line.oldNo, oldLines.length)
        oldLines.push(line.text)
      }
      if (line.newNo !== undefined) {
        newIndex.set(line.newNo, newLines.length)
        newLines.push(line.text)
      }
    }
  }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n"), oldIndex, newIndex }
}

// ---- conflicts ----------------------------------------------------------------

export type ConflictSide = "ours" | "base" | "theirs" | "marker" | "plain"

export interface ConflictLine {
  text: string
  side: ConflictSide
  /** 1-based line number in the file as it is on disk. */
  no: number
}

/**
 * Reads a working copy with merge markers in it.
 *
 * `<<<<<<<` opens ours, `|||||||` (diff3 style) opens the base, `=======`
 * switches to theirs, `>>>>>>>` closes. Anything outside a block is plain.
 * A marker inside a string that happens to start a line will fool this, as
 * it fools everyone else's.
 */
export function parseConflict(content: string): { lines: ConflictLine[]; conflicts: number } {
  const lines: ConflictLine[] = []
  let side: ConflictSide = "plain"
  let conflicts = 0
  const raw = content.split("\n")
  if (raw[raw.length - 1] === "") raw.pop()
  raw.forEach((text, i) => {
    const no = i + 1
    if (text.startsWith("<<<<<<<")) {
      side = "ours"
      conflicts++
      lines.push({ text, side: "marker", no })
    } else if (text.startsWith("|||||||") && side === "ours") {
      side = "base"
      lines.push({ text, side: "marker", no })
    } else if (text.startsWith("=======") && (side === "ours" || side === "base")) {
      side = "theirs"
      lines.push({ text, side: "marker", no })
    } else if (text.startsWith(">>>>>>>") && side === "theirs") {
      side = "plain"
      lines.push({ text, side: "marker", no })
    } else {
      lines.push({ text, side, no })
    }
  })
  return { lines, conflicts }
}
