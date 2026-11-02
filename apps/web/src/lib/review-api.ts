import type { ReviewFinding, ReviewRecord, ReviewScope } from "@ucch/protocol"

import { projectApiUrl, type ProjectTarget } from "./project-target"

/**
 * Code reviews by OMP's reviewer (solution §9.3, OM7.8): a tree's latest,
 * newest first, from `GET /api/projects/{hash}/reviews`. A review is started
 * with the `review.run` command and finishes as `review.completed` or
 * `review.failed` on the project's stream.
 */
export async function fetchReviews(target: ProjectTarget): Promise<ReviewRecord[]> {
  const response = await fetch(projectApiUrl(target, "reviews"), { credentials: "include" })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Could not load the reviews.")
  }
  return ((await response.json()) as { reviews: ReviewRecord[] }).reviews
}

/** What a review looked at, in words: "the uncommitted changes", "commit 1a2b3c4". */
export function reviewSubject(review: { scope: ReviewScope; ref: string | null }): string {
  if (review.scope === "uncommitted") return "the uncommitted changes"
  if (review.scope === "branch") return review.ref ? `the branch since ${review.ref}` : "the branch"
  return review.ref ? `commit ${review.ref.slice(0, 7)}` : "the last commit"
}

/** What the Git view is showing, for deciding whose findings to draw on it. */
export type ReviewedView = { kind: "change" } | { kind: "commit"; sha: string }

/**
 * Whether a review's findings belong on what is shown: a commit's review on
 * that commit, the working tree's and the branch's on the changes.
 */
export function reviewApplies(review: Pick<ReviewRecord, "scope" | "ref">, view: ReviewedView): boolean {
  if (review.scope === "commit") return view.kind === "commit" && !!review.ref && view.sha.startsWith(review.ref)
  return view.kind === "change"
}

/** A review's findings on one file. */
export function findingsOn(review: Pick<ReviewRecord, "findings"> | null, path: string): ReviewFinding[] {
  return review ? review.findings.filter((finding) => finding.file === path) : []
}

/** `math.ts:2`, `math.ts:2-5`, or the file alone when the reviewer named no line. */
export function findingPlace(finding: Pick<ReviewFinding, "file" | "startLine" | "endLine">): string {
  if (finding.startLine <= 0) return finding.file
  return finding.endLine > finding.startLine ? `${finding.file}:${finding.startLine}-${finding.endLine}` : `${finding.file}:${finding.startLine}`
}

/**
 * The message Send to agent posts to the session: the findings picked, most
 * serious first, each with where it is and what the reviewer said.
 */
export function findingsMessage(review: Pick<ReviewRecord, "scope" | "ref" | "verdict">, findings: readonly ReviewFinding[]): string {
  const verdict = review.verdict ? ` The reviewer judged it ${review.verdict.verdict}.` : ""
  const lines = [
    `A code review of ${reviewSubject(review)} found ${findings.length === 1 ? "this" : `these ${findings.length} findings`}.${verdict} Please fix ${findings.length === 1 ? "it" : "them"}, or say why not.`,
    "",
  ]
  findings.forEach((finding, i) => {
    lines.push(`${i + 1}. [${finding.priority}] ${finding.title} (${findingPlace(finding)})`)
    for (const line of finding.body.trim().split("\n")) if (line.trim()) lines.push(`   ${line}`)
  })
  return lines.join("\n")
}
