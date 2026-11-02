"use client"

import * as React from "react"
import type { ReviewFinding, ReviewRecord } from "@ucch/protocol"
import { CheckCircle2Icon, ChevronDownIcon, Loader2Icon, SendIcon, ShieldAlertIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { findingPlace, reviewSubject } from "@/lib/review-api"
import { relativeTime } from "@/lib/stats-format"
import { cn } from "@/lib/utils"

import { ConfidenceBar, PriorityBadge } from "./review-finding"
import type { ReviewsState } from "./use-reviews"

/**
 * The verdict of the review the Git view is showing (solution §9.3, OM7.8):
 * whether the reviewer judged the change correct, why, and its findings,
 * which can be picked and sent to the session's agent as a message. A
 * review still running is a line with a spinner; a failed one says why.
 * Older reviews of the tree are a menu away.
 */
export function ReviewBanner({ state, onOpen }: { state: ReviewsState; onOpen(finding: ReviewFinding, review: ReviewRecord): void }) {
  const { active, reviews } = state
  if (state.error) {
    return (
      <Strip tone="error" testId="review-error">
        <p className="min-w-0 flex-1 break-words">{state.error}</p>
        <button type="button" onClick={state.clearError} aria-label="Dismiss" className="shrink-0 rounded p-0.5 hover:bg-danger-soft">
          <XIcon className="size-3.5" />
        </button>
      </Strip>
    )
  }
  if (!active) return null
  const picker = reviews.length > 1 ? <ReviewPicker state={state} /> : null
  if (active.status === "running") {
    return (
      <Strip tone="info" testId="review-running">
        <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
        <p className="min-w-0 flex-1 truncate">Reviewing {reviewSubject(active)}…</p>
        {picker}
      </Strip>
    )
  }
  if (active.status === "failed") {
    return (
      <Strip tone="error" testId="review-failed">
        <ShieldAlertIcon className="size-3.5 shrink-0" />
        <p className="min-w-0 flex-1 break-words">
          The review of {reviewSubject(active)} failed: {active.error ?? "no reason given"}
        </p>
        {picker}
      </Strip>
    )
  }
  return <Verdict key={active.id} review={active} state={state} picker={picker} onOpen={onOpen} />
}

function Verdict({
  review,
  state,
  picker,
  onOpen,
}: {
  review: ReviewRecord
  state: ReviewsState
  picker: React.ReactNode
  onOpen(finding: ReviewFinding, review: ReviewRecord): void
}) {
  const correct = review.verdict?.verdict === "correct"
  const [open, setOpen] = React.useState(review.findings.length > 0)
  // Every finding is picked to start with; Send to agent sends the picked ones.
  const [picked, setPicked] = React.useState<ReadonlySet<number>>(() => new Set(review.findings.map((_, i) => i)))
  const [sending, setSending] = React.useState(false)
  const chosen = review.findings.filter((_, i) => picked.has(i))
  const counts = (["P0", "P1", "P2", "P3"] as const)
    .map((p) => [p, review.findings.filter((f) => f.priority === p).length] as const)
    .filter(([, n]) => n > 0)
  const toggle = (i: number) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <div
      data-testid="review-verdict"
      data-verdict={review.verdict?.verdict ?? "unknown"}
      className={cn("border-b text-xs", correct ? "bg-success-soft" : "bg-danger-soft")}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        {correct ? (
          <CheckCircle2Icon className="text-success mt-px size-4 shrink-0" />
        ) : (
          <ShieldAlertIcon className="text-danger mt-px size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {correct ? "The reviewer judged" : "The reviewer found problems in"} {reviewSubject(review)}
            {correct ? " correct" : ""}
          </p>
          {review.verdict?.explanation && <p className="text-muted-foreground mt-0.5">{review.verdict.explanation}</p>}
          <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            {counts.length === 0 ? (
              <span>No findings</span>
            ) : (
              counts.map(([priority, n]) => (
                <span key={priority} className="inline-flex items-center gap-1">
                  <PriorityBadge priority={priority} /> {n}
                </span>
              ))
            )}
            {review.verdict && <ConfidenceBar confidence={review.verdict.confidence} />}
            {review.completedAt && <span title={new Date(review.completedAt).toLocaleString()}>{relativeTime(review.completedAt)}</span>}
            {review.model && <span className="truncate">{review.model}</span>}
            {review.costUsd > 0 && <span className="tabular-nums">${review.costUsd.toFixed(review.costUsd < 0.01 ? 4 : 2)}</span>}
          </p>
          {review.excluded.length > 0 && (
            <p className="text-muted-foreground mt-1" data-testid="review-excluded">
              Left out: {review.excluded.join(", ")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {picker}
          {review.findings.length > 0 && (
            <Button variant="ghost" size="xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              Findings
              <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
            </Button>
          )}
        </div>
      </div>
      {open && review.findings.length > 0 && (
        <div className="bg-background/60 border-t">
          <ul className="max-h-56 overflow-y-auto py-1">
            {review.findings.map((finding, i) => (
              <li key={i} className="flex items-start gap-2 px-3 py-1">
                <input
                  type="checkbox"
                  className="accent-ucch-active mt-0.5 size-3.5 shrink-0"
                  checked={picked.has(i)}
                  onChange={() => toggle(i)}
                  aria-label={`Send “${finding.title}” to the agent`}
                />
                <PriorityBadge priority={finding.priority} />
                <button type="button" onClick={() => onOpen(finding, review)} className="min-w-0 flex-1 text-left hover:underline">
                  <span className="font-medium">{finding.title}</span>{" "}
                  <span className="text-muted-foreground font-mono text-[0.65rem]">{findingPlace(finding)}</span>
                </button>
                <ConfidenceBar confidence={finding.confidence} />
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2 border-t px-3 py-1.5">
            <p className="text-muted-foreground min-w-0 flex-1 truncate">
              {state.threadId
                ? `${chosen.length} of ${review.findings.length} picked`
                : "Open a session to send findings to its agent."}
            </p>
            <Button
              size="xs"
              data-testid="review-send"
              disabled={!state.threadId || chosen.length === 0 || sending}
              onClick={async () => {
                setSending(true)
                await state.send(review, chosen)
                setSending(false)
              }}
            >
              {sending ? <Loader2Icon className="animate-spin" /> : <SendIcon />}
              Send to agent
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function ReviewPicker({ state }: { state: ReviewsState }) {
  return (
    <select
      aria-label="Show an earlier review"
      value={state.active?.id ?? ""}
      onChange={(event) => state.pick(event.target.value)}
      className="bg-background/70 h-6 max-w-44 rounded border px-1 text-xs"
    >
      {state.reviews.map((review) => (
        <option key={review.id} value={review.id}>
          {relativeTime(review.createdAt)} · {reviewSubject(review)}
          {review.status === "running" ? " (running)" : review.status === "failed" ? " (failed)" : ""}
        </option>
      ))}
    </select>
  )
}

function Strip({ tone, testId, children }: { tone: "info" | "error"; testId: string; children: React.ReactNode }) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex items-center gap-2 border-b px-3 py-2 text-xs",
        tone === "error" ? "bg-danger-soft text-destructive" : "bg-muted/60 text-muted-foreground",
      )}
    >
      {children}
    </div>
  )
}
