import type { DomainEvent, PeerReviewFinding, PeerReviewVerdict } from "@ucch/protocol";

/**
 * What the chat knows about a `@reviewer` or `@council` run (plan4 §4.2,
 * §4.3), folded from its `agent.peer_review_*` / `agent.council_*` events.
 * Rebuilt from the log on every render, so a reload draws the same card.
 */

type Member = Extract<DomainEvent, { type: "agent.peer_review_started" }>["reviewers"][number];

export type DeliberationStatus = "running" | "completed" | "failed" | "cancelled";
export type CancelledBy = Extract<DomainEvent, { type: "agent.deliberation_cancelled" }>["by"];

export interface ReviewerState extends Member {
  status: "running" | "completed" | "failed";
  verdict?: PeerReviewVerdict;
  summary?: string;
  findings?: PeerReviewFinding[];
  rawText?: boolean;
  costUsd?: number;
  error?: string;
}

export interface PeerReviewState {
  kind: "peer_review";
  id: string;
  /** The answer it reviews; null until the review has started. */
  targetTurnId: string | null;
  status: DeliberationStatus;
  fix: boolean;
  rereviewOf?: string;
  reviewers: ReviewerState[];
  costUsd: number;
  fixSkipped?: string;
  /** No reviewer could start, or the answer did not finish. */
  error?: string;
  cancelledBy?: CancelledBy;
}

export interface CouncilMemberState extends Member {
  seat: string;
  status: "thinking" | "answered" | "dropped";
  error?: string;
}

export interface CouncilPositionState {
  seat: string;
  recommendation: string;
  confidence: number;
  reasons: string[];
  risks: string[];
  changed: boolean;
}

export interface CouncilState {
  kind: "council";
  id: string;
  /** The held turn, which becomes the moderator's answer. */
  turnId: string;
  question: string;
  rounds: number;
  status: DeliberationStatus;
  members: CouncilMemberState[];
  /** Positions by round: `positions[0]` the opening answers. */
  positions: CouncilPositionState[][];
  conclusion?: Omit<Extract<DomainEvent, { type: "agent.council_concluded" }>, "type" | "threadId" | "deliberationId">;
  error?: string;
  cancelledBy?: CancelledBy;
}

export type DeliberationState = PeerReviewState | CouncilState;

const DELIBERATION_EVENTS = new Set<string>([
  "agent.peer_review_requested",
  "agent.peer_review_started",
  "agent.peer_review_completed",
  "agent.peer_review_failed",
  "agent.peer_review_ended",
  "agent.council_started",
  "agent.council_position",
  "agent.council_dropped",
  "agent.council_concluded",
  "agent.council_failed",
  "agent.deliberation_cancelled",
]);

export function isDeliberationEvent(event: DomainEvent): event is Extract<DomainEvent, { deliberationId: string; threadId: string }> &
  { type: `agent.${"peer_review" | "council" | "deliberation"}_${string}` } {
  return DELIBERATION_EVENTS.has(event.type);
}

/**
 * Folds one event into the run it belongs to. Returns the state when the
 * event opened a new run (the caller places its row), otherwise null.
 */
export function foldDeliberation(byId: Map<string, DeliberationState>, event: DomainEvent): DeliberationState | null {
  if (!isDeliberationEvent(event)) return null;
  const known = byId.get(event.deliberationId);
  switch (event.type) {
    case "agent.peer_review_requested": {
      if (known) return null;
      const state: PeerReviewState = {
        kind: "peer_review",
        id: event.deliberationId,
        targetTurnId: event.turnId ?? null,
        status: "running",
        fix: event.directive.fix,
        reviewers: [],
        costUsd: 0,
      };
      byId.set(state.id, state);
      return state;
    }
    case "agent.peer_review_started": {
      const reviewers: ReviewerState[] = event.reviewers.map((member) => ({ ...member, status: "running" }));
      if (known?.kind === "peer_review") {
        known.targetTurnId = event.targetTurnId;
        known.fix = event.fix;
        known.reviewers = reviewers;
        if (event.rereviewOf) known.rereviewOf = event.rereviewOf;
        return null;
      }
      const state: PeerReviewState = {
        kind: "peer_review",
        id: event.deliberationId,
        targetTurnId: event.targetTurnId,
        status: "running",
        fix: event.fix,
        reviewers,
        costUsd: 0,
        ...(event.rereviewOf ? { rereviewOf: event.rereviewOf } : {}),
      };
      byId.set(state.id, state);
      return state;
    }
    case "agent.peer_review_completed": {
      if (known?.kind !== "peer_review") return null;
      const reviewer = known.reviewers.find((r) => r.subagentId === event.subagentId);
      if (!reviewer) return null;
      reviewer.status = "completed";
      reviewer.verdict = event.verdict;
      reviewer.summary = event.summary;
      reviewer.findings = event.findings;
      reviewer.costUsd = event.costUsd;
      if (event.rawText) reviewer.rawText = true;
      return null;
    }
    case "agent.peer_review_failed": {
      if (known && known.kind !== "peer_review") return null;
      const state: PeerReviewState =
        known ?? { kind: "peer_review", id: event.deliberationId, targetTurnId: null, status: "running", fix: false, reviewers: [], costUsd: 0 };
      const created = !known;
      if (created) byId.set(state.id, state);
      const reviewer = event.subagentId ? state.reviewers.find((r) => r.subagentId === event.subagentId) : undefined;
      if (reviewer) {
        reviewer.status = "failed";
        reviewer.error = event.error;
      } else {
        state.error = event.error;
        state.status = "failed";
      }
      return created ? state : null;
    }
    case "agent.peer_review_ended": {
      if (known?.kind !== "peer_review") return null;
      if (known.status === "running") known.status = event.status;
      known.costUsd = event.costUsd;
      if (event.fixSkipped) known.fixSkipped = event.fixSkipped;
      return null;
    }
    case "agent.council_started": {
      const state: CouncilState = {
        kind: "council",
        id: event.deliberationId,
        turnId: event.turnId,
        question: event.question,
        rounds: event.rounds,
        status: "running",
        members: event.members.map((member) => ({ ...member, status: "thinking" })),
        positions: [],
      };
      byId.set(state.id, state);
      return known ? null : state;
    }
    case "agent.council_position": {
      if (known?.kind !== "council") return null;
      const round = (known.positions[event.round] ??= []);
      const position: CouncilPositionState = {
        seat: event.seat,
        recommendation: event.recommendation,
        confidence: event.confidence,
        reasons: event.reasons,
        risks: event.risks,
        changed: event.changed,
      };
      const at = round.findIndex((p) => p.seat === event.seat);
      if (at === -1) round.push(position);
      else round[at] = position;
      round.sort((a, b) => a.seat.localeCompare(b.seat));
      const member = known.members.find((m) => m.seat === event.seat);
      if (member && member.status !== "dropped") member.status = "answered";
      return null;
    }
    case "agent.council_dropped": {
      if (known?.kind !== "council") return null;
      const member = known.members.find((m) => m.seat === event.seat);
      if (member) {
        member.status = "dropped";
        member.error = event.error;
      }
      return null;
    }
    case "agent.council_concluded": {
      if (known?.kind !== "council") return null;
      const { type: _type, threadId: _thread, deliberationId: _id, ...conclusion } = event;
      known.conclusion = conclusion;
      known.status = "completed";
      return null;
    }
    case "agent.council_failed": {
      if (known?.kind !== "council") return null;
      known.status = "failed";
      known.error = event.error;
      return null;
    }
    case "agent.deliberation_cancelled": {
      if (!known) return null;
      known.status = "cancelled";
      known.cancelledBy = event.by;
      return null;
    }
  }
  return null;
}

/** Every finding a fix would send: the nits are left out, as the server does. */
export function fixableFindings(state: PeerReviewState): PeerReviewFinding[] {
  return state.reviewers.flatMap((r) => r.findings ?? []).filter((f) => f.severity !== "nit");
}

export const SEVERITY_ORDER: readonly PeerReviewFinding["severity"][] = ["critical", "major", "minor", "nit"];

/** A review's overall verdict: the worst any reviewer gave, once every one is in. */
export function overallVerdict(state: PeerReviewState): PeerReviewVerdict | null {
  const verdicts = state.reviewers.map((r) => r.verdict).filter((v): v is PeerReviewVerdict => Boolean(v));
  if (verdicts.length === 0) return null;
  if (verdicts.includes("incorrect")) return "incorrect";
  if (verdicts.includes("changes_requested")) return "changes_requested";
  return "approve";
}

export const VERDICT_LABEL: Record<PeerReviewVerdict, string> = {
  approve: "Approved",
  changes_requested: "Changes requested",
  incorrect: "Incorrect",
};

export const CONSENSUS_LABEL = { unanimous: "Unanimous", majority: "Majority", split: "Split" } as const;
