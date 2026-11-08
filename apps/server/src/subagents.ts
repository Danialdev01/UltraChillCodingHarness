import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { projects, threads, turns, type Database } from "@ucch/db";
import {
  isTransient,
  resolveHarness,
  type CatalogueModel,
  type Command,
  type DomainEvent,
  type ProviderId,
  type TokenUsage,
} from "@ucch/protocol";
import type { Principal } from "./auth.js";
import type { EventBus } from "./bus.js";
import { harnessLabel, limitOptions, type ChoiceWaiters, type HarnessAvailability } from "./choices.js";
import type { EngineResult } from "./engine.js";
import { applyProjection } from "./engine.js";
import type { EventStore } from "./eventstore.js";

/** What a `ucch_agent` call asked for. */
export interface SubagentRequest {
  description: string;
  task: string;
  model?: string | undefined;
}

/** The parent's turn and the tool call that asked, for the card's place in the chat. */
export interface SubagentCall {
  turnId: string;
  toolUseId: string | null;
}

export interface SubagentDeps {
  db: Database;
  store: EventStore;
  bus: Pick<EventBus, "subscribe">;
  dispatch(principal: Principal, command: Command): Promise<EngineResult>;
  /** The harnesses the subject that pays could run a turn on now. */
  harnesses(subject: string): Promise<HarnessAvailability[]>;
  /** The OpenRouter catalogue, for models no CLI of the person's runs. */
  catalogue(): Promise<CatalogueModel[]>;
  /** What runs OpenRouter models on this server. */
  customProvider: "omp" | "native";
  /** The parent's running turn, and which of its tool calls this is. Null: no turn is running. */
  claimCall(parentThreadId: string, request: SubagentRequest): Promise<SubagentCall | null>;
  choices: ChoiceWaiters;
  /** A subagent's session has nobody watching it to answer a permission prompt. */
  allowAllFor(threadId: string): void;
  onError(error: unknown): void;
}

/** The most of a subagent's answer its card keeps; the tool result gets all of it. */
const RESULT_CHARS = 8_000;
/** At most one progress line a second, as the CLI subagents' are. */
const PROGRESS_MS = 1_000;

const PREAMBLE = [
  "You are a subagent. Another agent started you for one task, and your final reply is all it receives.",
  "You cannot see its conversation; everything you need is below. Work in this folder, and finish with a",
  "concise report of what you did and found.",
].join(" ");

type ChildOutcome =
  | { kind: "done"; text: string; usage?: TokenUsage; costUsd?: number }
  | { kind: "limit"; error: string }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

/**
 * `ucch_agent` (any harness's): a subagent that runs as a session of its
 * own -- hidden from the sessions list, in its parent's folder -- on
 * whichever harness the model it was asked for routes to
 * (`resolveHarness`). Its parent's chat shows it as a subagent card under
 * the tool call, with its harness and a link to its transcript.
 *
 * A usage limit on the subagent's harness asks the person, on the parent,
 * how it should carry on; the answer switches the subagent's session to
 * another harness (`thread.switch_harness`, with the brief of its work so
 * far), and the parent's tool call waits on through it.
 */
export class SubagentRunner {
  constructor(private readonly deps: SubagentDeps) {}

  /**
   * Runs one subagent to its end. `subject` is whose subscriptions pay (the
   * parent turn's); `call`, when the harness knows it, the tool call -- a
   * bridge call is matched to its parent's tool call by `claimCall`.
   */
  async spawn(
    parentThreadId: string,
    subject: string,
    request: SubagentRequest,
    signal: AbortSignal,
    call?: SubagentCall,
  ): Promise<{ text: string } | { error: string }> {
    const { db } = this.deps;
    const [parent] = await db
      .select({
        id: threads.id,
        projectId: threads.projectId,
        provider: threads.provider,
        createdByUserId: threads.createdByUserId,
        parentThreadId: threads.parentThreadId,
        creator: projects.userId,
      })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .where(eq(threads.id, parentThreadId))
      .limit(1);
    if (!parent) return { error: "the session that asked for this subagent is gone" };
    if (parent.parentThreadId) return { error: "a subagent cannot start subagents of its own" };
    const parentProvider = knownProvider(parent.provider) ?? this.deps.customProvider;

    const [lastTurn] = await db
      .select({ model: turns.model })
      .from(turns)
      .where(eq(turns.threadId, parentThreadId))
      .orderBy(desc(turns.seq))
      .limit(1);
    const harnesses = await this.deps.harnesses(subject);
    const catalogue = request.model?.trim() ? await this.deps.catalogue().catch(() => []) : [];
    const routing = resolveHarness(request.model, {
      harnesses: harnesses.map(({ provider, usable }) => ({ provider, usable })),
      catalogue,
      parent: { provider: parentProvider, model: lastTurn?.model ?? null },
      customProvider: this.deps.customProvider,
    });
    if (!routing.ok) {
      return {
        error: routing.candidates.length
          ? `${routing.reason}: ${routing.candidates.join(", ")}`
          : routing.reason,
      };
    }

    const placed = call ?? (await this.deps.claimCall(parentThreadId, request));
    if (!placed) return { error: "the turn that asked for this subagent is over" };

    const principal: Principal = {
      userId: parent.createdByUserId ?? parent.creator,
      sessionId: "subagent",
      scopes: ["exec"],
      internal: true,
    };
    const created = await this.deps.dispatch(principal, {
      type: "thread.create",
      projectId: parent.projectId,
      title: request.description.slice(0, 200),
      parentThreadId,
    });
    if (!created.ok) return { error: `could not start the subagent's session: ${created.message}` };
    const made = created.events.find((stored) => stored.event.type === "thread.created")?.event;
    if (made?.type !== "thread.created" || !made.hash) return { error: "could not start the subagent's session" };
    const childId = made.threadId;
    this.deps.allowAllFor(childId);

    const subagentId = randomUUID();
    const started = Date.now();
    const onParent = (events: DomainEvent[]) =>
      this.deps.store
        .append(
          { projectId: parent.projectId, threadId: parentThreadId },
          events,
          events.every((event) => isTransient(event.type)) ? undefined : (tx) => applyProjection(tx, events, null),
        )
        .catch(this.deps.onError);
    await onParent([
      {
        type: "agent.subagent_started",
        threadId: parentThreadId,
        turnId: placed.turnId,
        subagentId,
        parentToolUseId: placed.toolUseId,
        agent: harnessLabel(routing.provider),
        description: request.description,
        model: routing.model,
        provider: routing.provider,
        childThreadId: childId,
        childHash: made.hash,
        routing: routing.label,
      },
    ]);

    let provider = routing.provider;
    let toolCalls = 0;
    let lastProgress = 0;
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    let costUsd = 0;
    const progress = (summary: string) => {
      const now = Date.now();
      if (now - lastProgress < PROGRESS_MS) return;
      lastProgress = now;
      void onParent([
        {
          type: "agent.subagent_progress",
          threadId: parentThreadId,
          turnId: placed.turnId,
          subagentId,
          summary: summary.slice(0, 200),
          toolCalls,
          durationMs: now - started,
        },
      ]);
    };
    const finish = async (status: "completed" | "failed" | "aborted", result: string) => {
      await onParent([
        {
          type: "agent.subagent_finished",
          threadId: parentThreadId,
          turnId: placed.turnId,
          subagentId,
          status,
          result: result.slice(0, RESULT_CHARS),
          usage,
          costUsd,
          toolCalls,
          durationMs: Date.now() - started,
        },
      ]);
    };

    // The first turn is the task; after a limit, the switch's own message.
    let start: () => Promise<EngineResult> = () =>
      this.deps.dispatch(principal, {
        type: "thread.send",
        threadId: childId,
        text: `${PREAMBLE}\n\n<task>\n${request.task.trim()}\n</task>`,
        provider,
        ...(routing.model ? { model: routing.model } : {}),
      });
    for (;;) {
      const outcome = await this.#childTurn(childId, principal, start, signal, {
        onTool: (name) => {
          toolCalls += 1;
          progress(name);
        },
        onText: (text) => progress(text),
      });
      if (outcome.kind === "done") {
        addUsage(usage, outcome.usage);
        costUsd += outcome.costUsd ?? 0;
        await finish("completed", outcome.text);
        return { text: outcome.text };
      }
      if (outcome.kind === "cancelled") {
        await finish("aborted", "Stopped.");
        return { error: "the subagent was stopped" };
      }
      if (outcome.kind === "failed") {
        await finish("failed", outcome.error);
        return { error: outcome.error };
      }

      // Its harness hit a usage limit: the person picks how it goes on.
      const requestId = randomUUID();
      const latest = await this.deps.harnesses(subject).catch(() => harnesses);
      await onParent([
        {
          type: "agent.choice_requested",
          threadId: parentThreadId,
          requestId,
          kind: "subagent_limit",
          title: `${harnessLabel(provider)} hit its usage limit on the subagent "${request.description}"`,
          detail: "Carry the subagent on with another harness or model. Its work so far goes over as a brief.",
          options: limitOptions(latest, provider),
          childThreadId: childId,
          subagentId,
          provider,
        },
      ]);
      const answer = await this.deps.choices.wait(requestId, signal);
      await onParent([
        {
          type: "agent.choice_resolved",
          threadId: parentThreadId,
          requestId,
          optionId: answer.optionId,
          ...(answer.model ? { model: answer.model } : {}),
        },
      ]);
      const picked = answer.optionId ? limitOptions(latest, provider).find((option) => option.id === answer.optionId) : undefined;
      if (!picked?.provider || picked.blocker) {
        const why = signal.aborted ? "the subagent was stopped" : `${harnessLabel(provider)} hit its usage limit, and the subagent was not carried on`;
        await finish(signal.aborted ? "aborted" : "failed", why);
        return { error: why };
      }
      if (picked.pickModel && !answer.model) {
        await finish("failed", "no model was picked to carry the subagent on");
        return { error: "no model was picked to carry the subagent on" };
      }
      provider = picked.provider;
      const model = answer.model ?? picked.model;
      start = () =>
        this.deps.dispatch(principal, {
          type: "thread.switch_harness",
          threadId: childId,
          targetProvider: picked.provider!,
          ...(model ? { model } : {}),
          reason: "limit",
          message: "Carry on with the task from where you left off.",
        });
    }
  }

  /**
   * One turn of the subagent's session, started by `start` (a send, or a
   * switch that sends), followed on the bus to its end. Its reply is the
   * text after its last tool call: the answer, not the narration.
   */
  async #childTurn(
    threadId: string,
    principal: Principal,
    start: () => Promise<EngineResult>,
    signal: AbortSignal,
    on: { onTool(name: string): void; onText(text: string): void },
  ): Promise<ChildOutcome> {
    if (signal.aborted) return { kind: "cancelled" };
    let reply = "";
    let settle!: (outcome: ChildOutcome) => void;
    const done = new Promise<ChildOutcome>((resolve) => {
      settle = resolve;
    });
    const unsubscribe = this.deps.bus.subscribe({ name: "thread", threadId }, ({ event }) => {
      switch (event.type) {
        case "agent.text_delta":
          reply += event.text;
          on.onText(reply.split("\n").filter(Boolean).at(-1) ?? "");
          break;
        case "agent.tool_use":
          reply = "";
          on.onTool(event.name);
          break;
        case "agent.turn_completed":
          settle(
            event.stopReason === "cancelled"
              ? { kind: "cancelled" }
              : { kind: "done", text: reply.trim(), usage: event.usage, costUsd: event.costUsd },
          );
          break;
        case "agent.turn_failed":
          settle(event.limit ? { kind: "limit", error: event.error } : { kind: "failed", error: event.error });
          break;
        case "turn.dequeued":
          settle(event.reason === "cancelled" ? { kind: "cancelled" } : { kind: "failed", error: "the subagent's turn could not start" });
          break;
        case "thread.harness_switch_failed":
          settle({ kind: "failed", error: `the subagent could not switch harness: ${event.error}` });
          break;
      }
    });
    const onAbort = () => {
      // The parent's call is gone: stop the subagent's turn too.
      void this.deps
        .dispatch(principal, { type: "thread.cancel", threadId })
        .catch(this.deps.onError);
      settle({ kind: "cancelled" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const started = await start();
      if (!started.ok) return { kind: "failed", error: `the subagent could not start: ${started.message}` };
      return await done;
    } finally {
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function knownProvider(value: string | null): ProviderId | null {
  return value === "native" || value === "claude" || value === "codex" || value === "omp" ? value : null;
}

function addUsage(total: TokenUsage, more: TokenUsage | undefined): void {
  if (!more) return;
  total.inputTokens += more.inputTokens;
  total.outputTokens += more.outputTokens;
  total.cacheReadInputTokens = (total.cacheReadInputTokens ?? 0) + (more.cacheReadInputTokens ?? 0);
  total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + (more.cacheCreationInputTokens ?? 0);
}
