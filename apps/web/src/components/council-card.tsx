"use client";

import { ChevronRightIcon, ExternalLinkIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { HarnessIcon } from "@/components/harness-icon";
import { useSessionHref } from "@/components/subagent-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CONSENSUS_LABEL, type CouncilMemberState, type CouncilPositionState, type CouncilState } from "@/lib/deliberations";
import { bareModelId } from "@/lib/model-keys";
import { useRealtime } from "@/lib/realtime";
import { formatUsd } from "@/lib/stats-format";
import { cn } from "@/lib/utils";
import { TransitionLink } from "@/lib/view-transitions";

const CONSENSUS_TONE = {
  unanimous: "bg-success-soft text-success",
  majority: "bg-warning-soft text-warning",
  split: "bg-danger-soft text-danger",
} as const;

const STATUS_LABEL: Record<CouncilMemberState["status"], string> = { thinking: "thinking", answered: "answered", dropped: "dropped" };

/**
 * A `@council` run (plan4 §4.3): drawn where the held turn waits, then
 * above the moderator's answer. The member strip says who sits where; each
 * round folds open to every seat's position; the conclusion names the
 * consensus and the dissent. Members see each other only as seat letters --
 * the models are shown here, to the person, not to them.
 */
export function CouncilCard({ state, threadId }: { state: CouncilState; threadId: string }) {
  const { client } = useRealtime();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = state.status === "running";
  const stop = async () => {
    if (!client) return;
    setStopping(true);
    setError(null);
    try {
      await client.dispatch({ type: "thread.deliberation_cancel", threadId, deliberationId: state.id });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStopping(false);
    }
  };
  const modelOf = (seat: string) => state.members.find((m) => m.seat === seat)?.model ?? null;
  const roundsRun = state.conclusion?.roundsRun ?? Math.max(0, state.positions.length - 1);

  return (
    <section className="bg-card flex flex-col gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="council-card" data-status={state.status}>
      <header className="flex flex-wrap items-center gap-2">
        <UsersIcon className="size-4" />
        <span className="font-medium">Council</span>
        {state.conclusion && (
          <span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", CONSENSUS_TONE[state.conclusion.consensus])} data-testid="council-consensus">
            {CONSENSUS_LABEL[state.conclusion.consensus]}
          </span>
        )}
        {running && <span className="text-muted-foreground text-xs">Deliberating…</span>}
        {state.status === "cancelled" && <span className="text-muted-foreground text-xs">Cancelled</span>}
        {state.status === "failed" && <span className="text-danger text-xs">Could not meet</span>}
      </header>
      <p className="text-muted-foreground line-clamp-2 text-xs">{state.question}</p>

      <ul className="flex flex-wrap gap-1.5" data-testid="council-members">
        {state.members.map((member) => (
          <Member key={member.seat} member={member} />
        ))}
      </ul>

      {state.positions.map((round, index) => (
        <details key={index} className="group/round border-t pt-1.5" open={index === state.positions.length - 1} data-testid="council-round">
          <summary className="text-muted-foreground flex cursor-pointer list-none items-center gap-1.5 text-xs select-none [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 transition-transform group-open/round:rotate-90" />
            {index === 0 ? "Opening positions" : `Round ${index}`}
            <span className="tabular-nums">· {round.length}</span>
          </summary>
          <ul className="mt-1.5 flex flex-col gap-2">
            {round.map((position) => (
              <Position key={position.seat} position={position} model={modelOf(position.seat)} />
            ))}
          </ul>
        </details>
      ))}
      {running && state.positions.length === 0 && (
        <div className="flex flex-col gap-1" aria-hidden>
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      )}

      {state.conclusion && (
        <div className="bg-muted/50 flex flex-col gap-1 rounded-md px-2.5 py-2" data-testid="council-conclusion">
          <span className="text-xs font-medium">Recommendation</span>
          <p className="whitespace-pre-wrap">{state.conclusion.recommendation}</p>
          {state.conclusion.dissent.map((dissent) => (
            <p key={dissent.seat} className="text-warning text-xs" data-testid="council-dissent">
              Seat {dissent.seat} dissents: {dissent.position}
            </p>
          ))}
          {state.conclusion.partial && <p className="text-muted-foreground text-xs">A member dropped out on the way.</p>}
          {state.conclusion.stopped && (
            <p className="text-muted-foreground text-xs">Ended early: {state.conclusion.stopped === "budget" ? "it reached its spend cap" : "it ran out of time"}.</p>
          )}
        </div>
      )}
      {state.error && <p className="text-danger text-xs" role="alert">{state.error}</p>}

      <footer className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs tabular-nums">
        <span>
          {roundsRun} of {state.rounds} {state.rounds === 1 ? "round" : "rounds"}
        </span>
        {state.conclusion && state.conclusion.costUsd > 0 && <span>· {formatUsd(state.conclusion.costUsd)}</span>}
        {running && (
          <Button size="sm" variant="outline" className="ml-auto" disabled={!client || stopping} onClick={() => void stop()} data-testid="council-stop">
            {stopping ? "Stopping…" : "Stop"}
          </Button>
        )}
      </footer>
      {error && <p className="text-danger text-xs" role="alert">{error}</p>}
    </section>
  );
}

function Member({ member }: { member: CouncilMemberState }) {
  const transcript = useSessionHref(member.childHash);
  const label = (
    <>
      <span className="font-medium">{member.seat}</span>
      <HarnessIcon harness={member.provider} size={12} />
      <span className="max-w-40 truncate font-mono">{member.model ? bareModelId(member.model) : "session model"}</span>
      <span className={cn(member.status === "dropped" ? "text-danger" : "text-muted-foreground")}>{STATUS_LABEL[member.status]}</span>
      {transcript && <ExternalLinkIcon className="size-3" />}
    </>
  );
  return (
    <li
      className="bg-muted/40 flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
      title={member.error ?? member.reason}
      data-testid="council-member"
      data-status={member.status}
    >
      {transcript ? (
        <TransitionLink href={transcript} className="hover:text-foreground flex items-center gap-1">
          {label}
        </TransitionLink>
      ) : (
        label
      )}
    </li>
  );
}

function Position({ position, model }: { position: CouncilPositionState; model: string | null }) {
  const pct = Math.round(position.confidence * 100);
  return (
    <li className="flex flex-col gap-1" data-testid="council-position">
      <span className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium">Seat {position.seat}</span>
        {model && <span className="text-muted-foreground font-mono">{bareModelId(model)}</span>}
        {position.changed && <span className="bg-warning-soft text-warning rounded px-1">changed position</span>}
        <span className="text-muted-foreground ml-auto flex items-center gap-1.5 tabular-nums">
          <span className="bg-muted relative h-1.5 w-16 overflow-hidden rounded" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Confidence">
            <span className="bg-ucch-active absolute inset-y-0 left-0" style={{ width: `${pct}%` }} />
          </span>
          {pct}%
        </span>
      </span>
      <p className="whitespace-pre-wrap">{position.recommendation}</p>
      {(position.reasons.length > 0 || position.risks.length > 0) && (
        <ul className="text-muted-foreground flex flex-col gap-0.5 pl-3 text-xs">
          {position.reasons.map((reason, i) => (
            <li key={`r${i}`} className="list-disc">{reason}</li>
          ))}
          {position.risks.map((risk, i) => (
            <li key={`k${i}`} className="text-warning list-disc">Risk: {risk}</li>
          ))}
        </ul>
      )}
    </li>
  );
}
