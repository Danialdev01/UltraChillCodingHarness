"use client"

import type { ReviewFinding } from "@ucch/protocol"

import { findingPlace } from "@/lib/review-api"
import { cn } from "@/lib/utils"

/**
 * A finding's two numbers, drawn apart. OMP's docs: "Confidence is not
 * severity". Priority is how much it matters (P0 blocks a merge); confidence
 * is how sure the reviewer is.
 */
export function PriorityBadge({ priority, className }: { priority: ReviewFinding["priority"]; className?: string }) {
  return (
    <span
      data-slot="review-priority"
      title={PRIORITY_MEANING[priority]}
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-px font-mono text-[0.65rem] font-semibold",
        priority === "P0" && "bg-danger-soft text-danger",
        priority === "P1" && "bg-warning-soft text-warning",
        priority === "P2" && "bg-accent-soft text-accent",
        priority === "P3" && "bg-muted text-muted-foreground",
        className,
      )}
    >
      {priority}
    </span>
  )
}

const PRIORITY_MEANING: Record<ReviewFinding["priority"], string> = {
  P0: "P0: blocks the change",
  P1: "P1: should be fixed before merging",
  P2: "P2: worth fixing",
  P3: "P3: a nit",
}

export function ConfidenceBar({ confidence, className }: { confidence: number; className?: string }) {
  const percent = Math.round(confidence * 100)
  return (
    <span
      data-slot="review-confidence"
      className={cn("text-muted-foreground inline-flex shrink-0 items-center gap-1 text-[0.65rem] tabular-nums", className)}
      title={`The reviewer is ${percent}% sure`}
    >
      <span className="bg-muted relative h-1 w-10 overflow-hidden rounded-full" aria-hidden>
        <span className="bg-foreground/60 absolute inset-y-0 left-0 rounded-full" style={{ width: `${percent}%` }} />
      </span>
      <span>{percent}%</span>
      <span className="sr-only">confidence</span>
    </span>
  )
}

/** A finding as a note under its lines in the diff. */
export function FindingNote({ finding }: { finding: ReviewFinding }) {
  return (
    <div
      data-testid="review-finding"
      data-priority={finding.priority}
      className="bg-background my-1 mr-3 ml-[5.5rem] rounded-md border px-3 py-2 font-sans whitespace-normal shadow-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <PriorityBadge priority={finding.priority} />
        <span className="min-w-0 flex-1 text-xs font-medium">{finding.title}</span>
        <ConfidenceBar confidence={finding.confidence} />
      </div>
      {finding.body.trim() && <p className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{finding.body.trim()}</p>}
      <p className="text-text-subtle mt-1 font-mono text-[0.65rem]">{findingPlace(finding)}</p>
    </div>
  )
}
