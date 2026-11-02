import type { ReviewFinding } from "@ucch/protocol"

import type { DiffFile } from "./git-diff"

/** Where a file's findings go in its diff (OM7.8). Lines are keyed `hunk:line`. */
export interface FindingAnchors {
  /** The findings drawn after a line: the last of its range that the diff shows. */
  after: Map<string, ReviewFinding[]>
  /** Lines inside some finding's range, marked in the gutter. */
  flagged: Set<string>
  /** Findings on lines the diff does not show, or on no line: drawn above the file. */
  outside: ReviewFinding[]
}

/**
 * Pins each finding to the diff. The reviewer numbers lines as the new file
 * has them (a deleted file's, as the old one had them), so a finding goes
 * after the last line of its range that appears in a hunk, and every line
 * of the range that appears is flagged.
 */
export function anchorFindings(file: DiffFile, findings: readonly ReviewFinding[]): FindingAnchors {
  const anchors: FindingAnchors = { after: new Map(), flagged: new Set(), outside: [] }
  const side = file.newPath === null ? "oldNo" : "newNo"
  for (const finding of findings) {
    const start = finding.startLine
    const end = Math.max(finding.endLine, start)
    let last: string | null = null
    if (start > 0) {
      file.hunks.forEach((hunk, h) =>
        hunk.lines.forEach((line, i) => {
          const no = line[side]
          if (no !== undefined && no >= start && no <= end) {
            last = `${h}:${i}`
            anchors.flagged.add(last)
          }
        }),
      )
    }
    if (last === null) {
      anchors.outside.push(finding)
      continue
    }
    const list = anchors.after.get(last)
    if (list) list.push(finding)
    else anchors.after.set(last, [finding])
  }
  return anchors
}
