"use client";

import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, ScaleIcon, SearchCheckIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { Command, PeerReviewFinding } from "@ucch/protocol";
import { HarnessIcon } from "@/components/harness-icon";
import { FileLink } from "@/components/markdown";
import { useSessionHref } from "@/components/subagent-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fixableFindings,
  overallVerdict,
  SEVERITY_ORDER,
  VERDICT_LABEL,
  type PeerReviewState,
  type ReviewerState,
} from "@/lib/deliberations";
import { bareModelId } from "@/lib/model-keys";
import { useRealtime } from "@/lib/realtime";
import { formatUsd } from "@/lib/stats-format";
import { cn } from "@/lib/utils";
import { TransitionLink } from "@/lib/view-transitions";

/** A model the card can offer for "Review with…". */
export interface ReviewModelChoice {
  id: string;
  label: string;
}

const VERDICT_TONE = {
  approve: "bg-success-soft text-success",
  changes_requested: "bg-warning-soft text-warning",
  incorrect: "bg-danger-soft text-danger",
} as const;

const SEVERITY_TONE: Record<PeerReviewFinding["severity"], string> = {
  critical: "text-danger",
  major: "text-warning",
  minor: "text-muted-foreground",
  nit: "text-muted-foreground",
};

/**
 * A `@reviewer` run, under the answer it reviews (plan4 §4.2): a verdict
 * per reviewer, the findings by severity, and the ways on from there --
 * send the checked findings back to the agent, review again, or stop.
 * Every figure comes from the thread's events; a reviewer that has not
 * reported yet is a skeleton, not a spinner.
 */
export function PeerReviewCard({ state, threadId, models = [] }: { state: PeerReviewState; threadId: string; models?: readonly ReviewModelChoice[] }) {
  const { client } = useRealtime();
  const [open, setOpen] = useState(true);
  const fixable = useMemo(() => fixableFindings(state), [state]);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const verdict = overallVerdict(state);
  const running = state.status === "running";
  const checked = fixable.filter((f) => !unchecked.has(f.id));

  const send = async (key: string, command: Command) => {
    if (!client) return;
    setBusy(key);
    setError(null);
    try {
      await client.dispatch(command);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };
  const toggle = (id: string) =>
    setUnchecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const title = state.rereviewOf ? "Re-review" : "Review";
  return (
    <section className="bg-card flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="peer-review-card" data-status={state.status}>
      <header className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="hover:text-foreground focus-visible:ring-ring flex items-center gap-1.5 rounded font-medium outline-none focus-visible:ring-2"
        >
          {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
          <SearchCheckIcon className="size-4" />
          {title}
        </button>
        {verdict && !running && (
          <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", VERDICT_TONE[verdict])} data-testid="peer-review-verdict">
            {VERDICT_LABEL[verdict]}
          </span>
        )}
        {running && <span className="text-muted-foreground text-xs">Reviewing…</span>}
        {state.status === "cancelled" && <span className="text-muted-foreground text-xs">Stopped{state.cancelledBy === "budget" ? ": over its spend cap" : state.cancelledBy === "timeout" ? ": out of time" : state.cancelledBy === "restart" ? ": the server restarted" : ""}</span>}
        {state.fix && <span className="text-muted-foreground text-xs">auto-fix</span>}
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{state.costUsd > 0 ? formatUsd(state.costUsd) : null}</span>
      </header>

      {open && (
        <>
          {state.error && <p className="text-danger text-xs" role="alert">{state.error}</p>}
          {state.reviewers.length === 0 && running && <Skeleton className="h-4 w-56" />}
          {state.reviewers.map((reviewer) => (
            <Reviewer key={reviewer.subagentId} reviewer={reviewer} unchecked={unchecked} onToggle={toggle} />
          ))}
          {state.fixSkipped && <p className="text-muted-foreground text-xs">Fix not sent: {state.fixSkipped}</p>}

          <footer className="flex flex-wrap items-center gap-2 pt-1">
            {running ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!client || busy !== null}
                onClick={() => void send("stop", { type: "thread.deliberation_cancel", threadId, deliberationId: state.id })}
                data-testid="peer-review-stop"
              >
                {busy === "stop" ? "Stopping…" : "Stop"}
              </Button>
            ) : (
              <>
                {fixable.length > 0 && (
                  <Button
                    size="sm"
                    disabled={!client || busy !== null || checked.length === 0}
                    onClick={() =>
                      void send("fix", {
                        type: "thread.peer_review_fix",
                        threadId,
                        peerReviewId: state.id,
                        ...(checked.length < fixable.length ? { findingIds: checked.map((f) => f.id) } : {}),
                      })
                    }
                    data-testid="peer-review-fix"
                  >
                    {busy === "fix" ? "Sending…" : `Ask agent to fix (${checked.length})`}
                  </Button>
                )}
                {state.targetTurnId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!client || busy !== null}
                    onClick={() =>
                      void send("again", {
                        type: "thread.peer_review",
                        threadId,
                        turnId: state.targetTurnId!,
                        models: state.reviewers.map((r) => r.model).filter((m): m is string => Boolean(m)).slice(0, 3),
                      })
                    }
                    data-testid="peer-review-again"
                  >
                    Review again
                  </Button>
                )}
                {state.targetTurnId && models.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      disabled={!client || busy !== null}
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                      data-testid="peer-review-with"
                    >
                      Review with…
                      <ChevronDownIcon className="size-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="max-h-72 overflow-auto">
                      {models.map((model) => (
                        <DropdownMenuItem
                          key={model.id}
                          onClick={() => void send("with", { type: "thread.peer_review", threadId, turnId: state.targetTurnId!, models: [model.id] })}
                        >
                          {model.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)} data-testid="peer-review-dismiss">
                  Dismiss
                </Button>
              </>
            )}
          </footer>
          {error && <p className="text-danger text-xs" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}

function Reviewer({ reviewer, unchecked, onToggle }: { reviewer: ReviewerState; unchecked: ReadonlySet<string>; onToggle: (id: string) => void }) {
  const transcript = useSessionHref(reviewer.childHash);
  const groups = SEVERITY_ORDER.map((severity) => ({ severity, findings: (reviewer.findings ?? []).filter((f) => f.severity === severity) })).filter(
    (group) => group.findings.length > 0,
  );
  return (
    <div className="flex flex-col gap-1.5 border-t pt-2 first-of-type:border-t-0 first-of-type:pt-0" data-testid="peer-reviewer">
      <span className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
        <HarnessIcon harness={reviewer.provider} size={14} />
        <span className="text-foreground font-mono">{reviewer.model ? bareModelId(reviewer.model) : "Session model"}</span>
        <span className="truncate">{reviewer.reason}</span>
        {transcript && (
          <TransitionLink href={transcript} className="hover:text-foreground flex items-center gap-1 underline-offset-2 hover:underline">
            Transcript
            <ExternalLinkIcon className="size-3" />
          </TransitionLink>
        )}
        {reviewer.verdict && (
          <span className={cn("ml-auto rounded px-1.5 py-0.5 font-medium", VERDICT_TONE[reviewer.verdict])}>{VERDICT_LABEL[reviewer.verdict]}</span>
        )}
      </span>
      {reviewer.status === "running" && (
        <div className="flex flex-col gap-1" aria-hidden>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      )}
      {reviewer.status === "failed" && <p className="text-danger text-xs">{reviewer.error ?? "The reviewer failed."}</p>}
      {reviewer.summary && <p className={cn("whitespace-pre-wrap", reviewer.rawText && "text-muted-foreground")}>{reviewer.summary}</p>}
      {groups.map((group) => (
        <div key={group.severity} className="flex flex-col gap-1">
          <span className={cn("text-xs font-medium capitalize", SEVERITY_TONE[group.severity])}>
            {group.severity} · {group.findings.length}
          </span>
          <ul className="flex flex-col gap-1">
            {group.findings.map((finding) => (
              <li key={finding.id} className="flex items-start gap-2" data-testid="peer-review-finding">
                {finding.severity !== "nit" && (
                  <input
                    type="checkbox"
                    className="focus-visible:ring-ring mt-1 shrink-0 rounded outline-none focus-visible:ring-2"
                    checked={!unchecked.has(finding.id)}
                    onChange={() => onToggle(finding.id)}
                    aria-label={`Send "${finding.title}" to fix`}
                  />
                )}
                <details className="group/finding min-w-0 flex-1">
                  <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 [&::-webkit-details-marker]:hidden">
                    <span className="font-medium">{finding.title}</span>
                    {finding.file && (
                      <span className="text-xs">
                        <FileLink path={finding.file} line={finding.line ?? null}>
                          {finding.line ? `${finding.file}:${finding.line}` : finding.file}
                        </FileLink>
                      </span>
                    )}
                  </summary>
                  <p className="text-muted-foreground mt-1 text-xs whitespace-pre-wrap">{finding.detail}</p>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {reviewer.status === "completed" && groups.length === 0 && !reviewer.rawText && (
        <p className="text-muted-foreground flex items-center gap-1 text-xs">
          <ScaleIcon className="size-3" />
          No findings.
        </p>
      )}
    </div>
  );
}
