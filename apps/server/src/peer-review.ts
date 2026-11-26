import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  PeerReviewFinding,
  PeerReviewVerdict,
  pickModels,
  type DomainEvent,
  type FileDiff,
  type ReviewerDirective,
} from "@ucch/protocol";
import type { Principal } from "./auth.js";
import {
  appendTo,
  clip,
  fencedJson,
  pickedModel,
  quoted,
  RunningDeliberations,
  type DeliberationDeps,
  type DeliberationParent,
} from "./deliberations.js";
import type { ReviewResult } from "./engine.js";
import type { ManagedAgent } from "./subagents.js";

export const PEER_REVIEW_TIMEOUT_MS = 15 * 60_000;
/** Past this the reviewer is told what changed and reads it itself. */
const DIFF_CHARS = 40_000;
const ANSWER_CHARS = 12_000;
const REQUEST_CHARS = 8_000;

export const PEER_REVIEW_BRIEF = [
  "You are an independent reviewer. Another agent, on another model, answered the request below in this folder. Verify its work; do not rewrite it. You are read-only: read and search, change nothing.",
  "Check: is it correct for the request; bugs; requirements missed; security; whether tests exist and were run; and claims in the answer that are not true. Open the files rather than trusting the answer or the diff. Report only what you can give a concrete reason for; no praise, no style preferences.",
  "End with exactly one fenced block, and nothing after it:",
  '```ucch-review\n{"verdict":"approve|changes_requested|incorrect","summary":"one short paragraph","findings":[{"severity":"critical|major|minor|nit","file":"path/in/worktree","line":12,"title":"short","detail":"what is wrong, why, and when it bites"}]}\n```',
  "`approve` with no findings is a good review of good work. `file` is relative to this folder; leave `file` and `line` out when a finding has none. At most 30 findings, worst first.",
].join("\n");

export const PEER_REVIEW_FIX_BRIEF = [
  "An independent reviewer checked your last answer and reported the findings below. Verify each one against the code before acting: fix the valid ones, and say which you reject and why. Run the relevant tests, and finish with what you changed.",
].join("\n");

export interface PeerReviewOptions {
  maxCostUsd: number;
  timeoutMs?: number;
  /** Between tries to send an automatic fix while the thread is busy. */
  fixRetryMs?: number;
}

export interface ParsedReview {
  verdict: PeerReviewVerdict;
  summary: string;
  findings: PeerReviewFinding[];
  rawText?: true;
}

const RawFinding = z.object({
  severity: PeerReviewFinding.shape.severity.catch("minor"),
  file: z.string().nullish(),
  line: z.coerce.number().int().positive().nullish().catch(null),
  title: z.string().trim().min(1),
  detail: z.string().catch(""),
});

/** A reviewer's answer as its verdict; what does not parse is shown as it was written. */
export function parseReviewBlock(text: string): ParsedReview {
  const block = z
    .object({ verdict: PeerReviewVerdict, summary: z.string().catch(""), findings: z.array(z.unknown()).catch([]) })
    .safeParse(fencedJson(text, "ucch-review"));
  if (!block.success) {
    return { verdict: "changes_requested", summary: text.trim().slice(0, 600), findings: [], rawText: true };
  }
  const findings = block.data.findings.flatMap((raw) => {
    const finding = RawFinding.safeParse(raw);
    if (!finding.success) return [];
    const { file, line, title, detail, severity } = finding.data;
    return [{ severity, title: title.slice(0, 300), detail: detail.slice(0, 4_000), ...(file ? { file: file.replace(/^\.\//, "").slice(0, 1_000) } : {}), ...(file && line ? { line } : {}) }];
  });
  return {
    verdict: block.data.verdict,
    summary: block.data.summary.slice(0, 4_000),
    findings: findings.slice(0, 30).map((finding, index) => ({ id: `f${index + 1}`, ...finding })),
  };
}

/** What a turn changed, for the reviewer: whole, or by name when there is too much of it. */
export function renderChanges(files: readonly FileDiff[], omitted: number): string {
  if (files.length === 0) return "The turn changed no files.";
  const stat = files.map((file) => `${file.change} ${file.oldPath ? `${file.oldPath} -> ` : ""}${file.path} (+${file.added} -${file.removed})`);
  if (omitted > 0) stat.push(`… and ${omitted} more files`);
  const patches = files.map((file) => `--- ${file.oldPath ?? file.path}\n+++ ${file.path}\n${file.patch}`).join("\n");
  if (patches.length > DIFF_CHARS || files.some((file) => file.truncated) || omitted > 0) {
    return `${stat.join("\n")}\n\nThe diff is too large to include: read these files yourself.`;
  }
  return `${stat.join("\n")}\n\n${patches}`;
}

interface ReviewedTurn {
  turnId: string;
  request: string;
  answer: string;
  changes: string;
  /** What it ran on, when the log says. */
  author?: DeliberationParent["author"];
  /** The review this turn fixes. */
  fixes?: string;
}

/** The turn to review as the log tells it: the named one, or the latest answer. */
export function reviewedTurn(history: readonly { event: DomainEvent }[], turnId?: string): ReviewedTurn | null {
  const events = history.map((row) => row.event);
  const done = events.findLastIndex(
    (event) => event.type === "agent.turn_completed" && event.stopReason !== "cancelled" && (!turnId || event.turnId === turnId),
  );
  const ended = events[done];
  if (ended?.type !== "agent.turn_completed") return null;
  const id = ended.turnId;
  const opened = events.findIndex((event) => event.type === "turn.started" && event.turnId === id);
  const asked = events.slice(0, opened === -1 ? done : opened).findLast((event) => event.type === "user.message");
  const message = asked?.type === "user.message" ? asked : null;
  const start = opened === -1 ? null : events[opened];
  const author = start?.type === "turn.started" && start.provider ? { provider: start.provider, model: start.model ?? null } : null;
  let answer: string[] = [];
  const files = new Map<string, string>();
  let changes: string | null = null;
  for (const event of events.slice(Math.max(0, opened), events.length)) {
    if (!("turnId" in event) || event.turnId !== id) continue;
    // The answer is what was said after the last tool call, as a reader takes it.
    if (event.type === "agent.tool_use" && !event.subagentId) answer = [];
    else if (event.type === "agent.message") {
      for (const block of event.content as { type?: unknown; text?: unknown }[]) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) answer.push(block.text.trim());
      }
    } else if (event.type === "agent.turn_diff") changes = renderChanges(event.files, event.omittedFiles);
    else if (event.type === "agent.file_diff") for (const file of event.files) files.set(file.path, file.change);
  }
  const named = [...files].map(([path, change]) => `${change} ${path}`).join("\n");
  return {
    turnId: id,
    request: message?.text ?? "",
    answer: answer.join("\n\n"),
    changes: changes ?? (named ? `${named}\n\nNo diff was recorded: read these files yourself.` : "The turn recorded no changed files."),
    ...(author ? { author } : {}),
    ...(message?.peerReviewId ? { fixes: message.peerReviewId } : {}),
  };
}

/** The request behind a fix turn: what the answer it fixes was asked. */
function originalRequest(history: readonly { event: DomainEvent }[], turn: ReviewedTurn): string {
  let current = turn;
  for (let depth = 0; current.fixes && depth < 10; depth++) {
    const started = history.find(({ event }) => event.type === "agent.peer_review_started" && event.deliberationId === current.fixes)?.event;
    const before = started?.type === "agent.peer_review_started" ? reviewedTurn(history, started.targetTurnId) : null;
    if (!before) break;
    current = before;
  }
  return current === turn ? turn.request : `${current.request}\n\n(Then, after a review:)\n${turn.request}`;
}

export function reviewTask(turn: Pick<ReviewedTurn, "answer" | "changes">, request: string): string {
  return [
    PEER_REVIEW_BRIEF,
    quoted("request", clip(request || "(not recorded)", REQUEST_CHARS)),
    quoted("answer", clip(turn.answer || "(no text: the turn ended without one)", ANSWER_CHARS)),
    quoted("changes", turn.changes),
  ].join("\n\n");
}

/** A review's findings as the message that sends them back, or null when there is nothing to fix. */
export function fixMessage(result: ReviewResult, options: { ids?: readonly string[]; nits: boolean }): string | null {
  const lines: string[] = [];
  for (const [subagentId, review] of Object.entries(result.reviews ?? {})) {
    if (review.status !== "completed") continue;
    for (const finding of review.findings ?? []) {
      if (options.ids ? !options.ids.includes(`${subagentId}:${finding.id}`) : !options.nits && finding.severity === "nit") continue;
      const where = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
      lines.push(`- [${finding.severity}]${where} ${finding.title}\n  ${finding.detail.replace(/\n/g, "\n  ")}`);
    }
    if (review.rawText && review.verdict !== "approve" && !options.ids && review.summary) lines.push(`- ${review.summary.replace(/\n/g, "\n  ")}`);
  }
  if (lines.length === 0) return null;
  return `${PEER_REVIEW_FIX_BRIEF}\n\n${quoted("findings", clip(lines.join("\n"), 50_000))}`;
}

/**
 * `@reviewer`: another agent, on another model where one is available,
 * checks an answer and reports. It changes nothing; its findings go back to
 * the agent that answered, at a person's click or (`fix`) once by itself.
 */
export class PeerReviewer {
  readonly running = new RunningDeliberations();
  constructor(
    private readonly deps: DeliberationDeps,
    private readonly options: PeerReviewOptions,
  ) {}

  /** A review that cannot be: its answer never finished. */
  async fail(parent: DeliberationParent, turnId: string, directive: ReviewerDirective, error: string, deliberationId: string = randomUUID()): Promise<void> {
    const ids = { threadId: parent.threadId, deliberationId };
    await appendTo(this.deps.store, parent)([
      { type: "agent.peer_review_started", ...ids, targetTurnId: turnId, reviewers: [], fix: directive.fix },
      { type: "agent.peer_review_failed", ...ids, error: error.slice(0, 2_000) },
      { type: "agent.peer_review_ended", ...ids, status: "failed", costUsd: 0 },
    ]);
  }

  async run(input: {
    parent: DeliberationParent;
    /** The turn to review; absent: the latest answer. */
    turnId?: string | undefined;
    directive: ReviewerDirective;
    principal: Principal;
    /** Given when the review was asked for by an event that names it. */
    deliberationId?: string | undefined;
  }): Promise<void> {
    const { directive } = input;
    const deliberationId = input.deliberationId ?? randomUUID();
    const ids = { threadId: input.parent.threadId, deliberationId };
    const append = appendTo(this.deps.store, input.parent);
    const controller = this.running.open(deliberationId, input.parent.threadId);
    const timer = setTimeout(() => controller.abort("timeout"), this.options.timeoutMs ?? PEER_REVIEW_TIMEOUT_MS);
    timer.unref?.();
    const agents: ManagedAgent[] = [];
    let opened = false;
    let costUsd = 0;
    try {
      const history = await this.deps.store.threadHistory(input.parent.threadId);
      const turn = reviewedTurn(history, input.turnId);
      if (!turn) {
        await this.fail(input.parent, input.turnId ?? randomUUID(), directive, "there is no finished answer to review", deliberationId);
        opened = true;
        return;
      }
      const author = turn.author ?? input.parent.author;
      const parent = { ...input.parent, author };
      const [settings, available, catalogue] = await Promise.all([
        this.deps.settings(parent.projectId),
        this.deps.harnesses(parent.subject),
        this.deps.catalogue().catch(() => []),
      ]);
      const picks = pickModels({
        role: "reviewer",
        author,
        count: Math.max(1, directive.models.length),
        explicit: directive.models,
        available,
        catalogue,
        preference: settings.reviewerModel,
      });
      const refused: string[] = [];
      const reviewers: Extract<DomainEvent, { type: "agent.peer_review_started" }>["reviewers"] = [];
      for (const pick of picks) {
        const agent = await this.deps.runner.startManaged({
          parentThreadId: parent.threadId,
          subject: parent.subject,
          turnId: turn.turnId,
          deliberationId,
          description: "Reviewer",
          model: pickedModel(pick, author),
          author,
          signal: controller.signal,
        });
        if ("error" in agent) {
          refused.push(agent.error);
          continue;
        }
        agents.push(agent);
        reviewers.push({
          subagentId: agent.subagentId,
          childThreadId: agent.childThreadId,
          childHash: agent.childHash,
          model: agent.model,
          provider: agent.provider,
          reason: pick.reason,
        });
      }
      opened = true;
      await append([
        { type: "agent.peer_review_started", ...ids, targetTurnId: turn.turnId, reviewers, fix: directive.fix, ...(turn.fixes ? { rereviewOf: turn.fixes } : {}) },
        ...refused.map((error) => ({ type: "agent.peer_review_failed" as const, ...ids, error: error.slice(0, 2_000) })),
      ]);

      const task = reviewTask(turn, originalRequest(history, turn));
      const result: ReviewResult = { reviews: {} };
      let completed = 0;
      await Promise.all(
        agents.map(async (agent) => {
          const outcome = await agent.turn(task);
          await agent.end().catch(this.deps.onError);
          if (outcome.kind === "done") {
            costUsd += outcome.costUsd;
            completed += 1;
            const review = parseReviewBlock(outcome.text);
            result.reviews![agent.subagentId] = { status: "completed", ...review };
            await append([{ type: "agent.peer_review_completed", ...ids, subagentId: agent.subagentId, ...review, costUsd: outcome.costUsd }]);
            // Paid for already, so kept; whoever is still at it is stopped.
            if (costUsd > this.options.maxCostUsd) controller.abort("budget");
          } else if (!controller.signal.aborted) {
            await append([{ type: "agent.peer_review_failed", ...ids, subagentId: agent.subagentId, error: outcome.error.slice(0, 2_000) }]);
          }
        }),
      );
      if (controller.signal.aborted && completed < agents.length) {
        await append([{ type: "agent.deliberation_cancelled", ...ids, by: controller.signal.reason }]);
        return;
      }
      const send = directive.fix && completed > 0 && Object.values(result.reviews!).some((review) => review.verdict !== "approve")
        ? fixMessage(result, { nits: false })
        : null;
      const skipped = send && costUsd > this.options.maxCostUsd ? "the review spent its budget" : null;
      await append([
        {
          type: "agent.peer_review_ended",
          ...ids,
          status: completed > 0 ? "completed" : "failed",
          costUsd,
          ...(skipped ? { fixSkipped: skipped } : {}),
        },
      ]);
      // The one fix: what it changes is reviewed once more, without `fix`.
      if (send && !skipped) await this.#sendFix(input.parent, input.principal, deliberationId, send, directive, controller.signal);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      if (!opened) await this.fail(input.parent, input.turnId ?? randomUUID(), directive, message, deliberationId);
      else {
        await append([
          { type: "agent.peer_review_failed", ...ids, error: message },
          { type: "agent.peer_review_ended", ...ids, status: "failed", costUsd },
        ]);
      }
    } finally {
      clearTimeout(timer);
      this.running.close(deliberationId);
      for (const agent of agents) {
        agent.stop();
        await agent.end().catch(this.deps.onError);
      }
    }
  }

  /** `thread.peer_review_fix`: the findings a person picked, as a turn of the thread's own agent. */
  async fix(
    parent: DeliberationParent,
    principal: Principal,
    peerReviewId: string,
    result: ReviewResult,
    ids?: readonly string[],
  ): Promise<void> {
    const text = fixMessage(result, { ...(ids ? { ids } : {}), nits: true });
    if (!text) return;
    const sent = await this.#dispatchFix(parent, principal, peerReviewId, text);
    if (!sent.ok) this.deps.onError(new Error(`could not send the findings of ${peerReviewId}: ${sent.message}`));
  }

  async #sendFix(parent: DeliberationParent, principal: Principal, peerReviewId: string, text: string, directive: ReviewerDirective, signal: AbortSignal): Promise<void> {
    // A compaction after the answer, or a message that came first, holds the thread a while.
    for (let attempt = 0; attempt < 60 && !signal.aborted; attempt++) {
      const sent = await this.#dispatchFix(parent, principal, peerReviewId, text, { models: directive.models, fix: false, previous: false });
      if (sent.ok) return;
      if (sent.code !== "conflict") throw new Error(`the findings could not be sent: ${sent.message}`);
      await new Promise((resolve) => setTimeout(resolve, this.options.fixRetryMs ?? 5_000));
    }
  }

  #dispatchFix(parent: DeliberationParent, principal: Principal, peerReviewId: string, text: string, reviewer?: ReviewerDirective) {
    return this.deps.dispatch(
      { ...principal, internal: true },
      {
        type: "thread.send",
        threadId: parent.threadId,
        text,
        peerReviewId,
        ...(reviewer ? { reviewer } : {}),
        ...(parent.author.model ? { model: parent.author.model } : {}),
      },
    );
  }
}
