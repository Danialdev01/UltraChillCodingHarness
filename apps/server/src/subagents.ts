import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { projects, threads, turns, type Database } from "@ucch/db";
import {
  isTransient,
  resolveHarness,
  parseModelRequest,
  type CatalogueModel,
  type Command,
  type DomainEvent,
  type ProviderId,
  type RoutingHarness,
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
  background?: boolean | undefined;
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
  harnesses(subject: string, model?: string): Promise<(HarnessAvailability & RoutingHarness)[]>;
  manage?(threadId: string): void;
  release?(threadId: string): void;
  notify?(parentThreadId: string, childThreadId: string, text: string): Promise<void>;
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
  "You are a subagent. Another agent started you for one task. Your final reply is returned to it; you may also use the project messaging tools to coordinate while working.",
  "You cannot see its conversation; everything you need is below. Work in this folder, and finish with a",
  "concise report of what you did and found.",
].join(" ");

type ChildOutcome =
  | { kind: "done"; text: string; usage?: TokenUsage; costUsd?: number }
  | { kind: "limit"; error: string }
  | { kind: "failed"; error: string }
  | { kind: "cancelled" };

/** How a subagent's work came out, after any fallback. */
export type RunOutcome =
  | { kind: "done"; text: string; costUsd: number }
  | { kind: "failed"; error: string }
  | { kind: "cancelled"; error: string };

interface LaunchRequest {
  description: string;
  model?: string | undefined;
  background?: boolean | undefined;
  /** A person may be asked how to go on at a usage limit. */
  attended: boolean;
  /** Its session changes nothing, and is asked nothing. */
  readOnly: boolean;
  /** What the parent's turn runs on, when its thread does not say yet. */
  author?: { provider: ProviderId; model: string | null } | undefined;
  deliberationId?: string | undefined;
}

interface Launched {
  childId: string;
  hash: string;
  subagentId: string;
  provider: ProviderId;
  model: string | null;
  routing: string;
  task(text: string): string;
  run(text: string): Promise<RunOutcome>;
  finish(outcome: RunOutcome): Promise<void>;
  abort(): void;
  close(): void;
}

export interface ManagedRequest {
  parentThreadId: string;
  /** Whose subscriptions pay. */
  subject: string;
  /** The turn its card belongs to. */
  turnId: string;
  deliberationId: string;
  description: string;
  /** Absent: the author's own. */
  model?: string | undefined;
  author: { provider: ProviderId; model: string | null };
  signal: AbortSignal;
}

export interface ManagedAgent {
  subagentId: string;
  childThreadId: string;
  childHash: string;
  provider: ProviderId;
  model: string | null;
  routing: string;
  /** The task, then each message after it, in the same session. */
  turn(text: string): Promise<RunOutcome>;
  stop(): void;
  end(): Promise<void>;
}

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
  private readonly active = new Map<string, { parentThreadId: string; controller: AbortController }>();
  constructor(private readonly deps: SubagentDeps) {}

  cancel(threadId: string): void {
    for (const [childId, run] of this.active) if (childId === threadId || run.parentThreadId === threadId) run.controller.abort();
  }

  shutdown(): void { for (const run of this.active.values()) run.controller.abort(); }


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
    const launched = await this.#launch(
      parentThreadId,
      subject,
      { ...request, attended: true, readOnly: false },
      signal,
      async () => call ?? (await this.deps.claimCall(parentThreadId, request)),
    );
    if ("error" in launched) return launched;
    const running = launched
      .run(launched.task(request.task))
      .then(async (outcome) => {
        await launched.finish(outcome);
        return outcome.kind === "done" ? { text: outcome.text } : { error: outcome.error };
      })
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        await launched.finish({ kind: "failed", error: message });
        return { error: message };
      })
      .finally(() => launched.close());
    if (!request.background) return running;
    void running.then(async (outcome) => {
      await this.deps.notify?.(parentThreadId, launched.childId, `Agent ${launched.childId} (${request.description}) ${"text" in outcome ? "completed" : "failed"}:\n${"text" in outcome ? outcome.text : outcome.error}`);
    }).catch(this.deps.onError);
    return { text: JSON.stringify({ sessionId: launched.childId, hash: launched.hash, subagentId: launched.subagentId, provider: launched.provider, model: launched.model, routing: launched.routing, status: "running" }) };
  }

  /**
   * A read-only subagent the server runs itself -- a reviewer, a council
   * member -- rather than one a tool call asked for. Its turns are the
   * caller's to start, one at a time, in one session, and nobody is asked
   * anything: a usage limit that the automatic fallback cannot get past
   * fails it. `end` closes its card and gives its session up.
   */
  async startManaged(request: ManagedRequest): Promise<ManagedAgent | { error: string }> {
    const launched = await this.#launch(
      request.parentThreadId,
      request.subject,
      { description: request.description, model: request.model, attended: false, readOnly: true, author: request.author, deliberationId: request.deliberationId },
      request.signal,
      async () => ({ turnId: request.turnId, toolUseId: null }),
    );
    if ("error" in launched) return launched;
    let turns = 0;
    let ended = false;
    let last: RunOutcome = { kind: "cancelled", error: "the subagent was stopped" };
    return {
      subagentId: launched.subagentId,
      childThreadId: launched.childId,
      childHash: launched.hash,
      provider: launched.provider,
      model: launched.model,
      routing: launched.routing,
      turn: async (text) => {
        last = await launched
          .run(turns++ === 0 ? launched.task(text) : text)
          .catch((error: unknown) => ({ kind: "failed" as const, error: error instanceof Error ? error.message : String(error) }));
        return last;
      },
      stop: () => launched.abort(),
      end: async () => {
        if (ended) return;
        ended = true;
        try {
          await launched.finish(last);
        } finally {
          launched.close();
        }
      },
    };
  }

  /** Routes a subagent, makes its session and puts its card on the parent; its turns follow. */
  async #launch(
    parentThreadId: string,
    subject: string,
    request: LaunchRequest,
    signal: AbortSignal,
    place: () => Promise<SubagentCall | null>,
  ): Promise<Launched | { error: string }> {
    if (signal.aborted) return { error: "the subagent was stopped" };
    const { db } = this.deps;
    const [parent] = await db
      .select({
        id: threads.id,
        projectId: threads.projectId,
        provider: threads.provider,
        createdByUserId: threads.createdByUserId,
        parentThreadId: threads.parentThreadId,
        credentialSource: threads.credentialSource,
        creator: projects.userId,
      })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .where(eq(threads.id, parentThreadId))
      .limit(1);
    if (!parent) return { error: "the session that asked for this subagent is gone" };
    if (parent.parentThreadId) return { error: "a subagent cannot start subagents of its own" };
    const parentProvider = request.author?.provider ?? knownProvider(parent.provider) ?? this.deps.customProvider;

    const [lastTurn] = request.author
      ? [{ model: request.author.model }]
      : await db
          .select({ model: turns.model })
          .from(turns)
          .where(eq(turns.threadId, parentThreadId))
          .orderBy(desc(turns.seq))
          .limit(1);
    const requestedModel = request.model?.trim() || lastTurn?.model || undefined;
    const harnesses = await this.deps.harnesses(subject, requestedModel);
    const catalogue = requestedModel ? await this.deps.catalogue().catch(() => []) : [];
    const routing = resolveHarness(request.model?.trim() || (parentProvider === "claude" || parentProvider === "codex" ? requestedModel : undefined), {
      harnesses,
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

    const family = requestedModel ? parseModelRequest(requestedModel).family : null;
    const subscription = harnesses.find((h) => h.provider === (family === "claude" ? "claude" : family === "openai" ? "codex" : routing.provider));
    const quota = subscription?.quota ?? { status: subscription?.usedPercent === undefined ? "unknown" : "ok", ...(subscription?.usedPercent !== undefined ? { usedPercent: subscription.usedPercent } : {}) };

    const placed = await place();
    if (!placed) return { error: "the turn that asked for this subagent is over" };

    if (signal.aborted) return { error: "the subagent was stopped" };
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
      ...(request.readOnly ? { readOnly: true } : {}),
      ...(parent.credentialSource === "workspace" || parent.credentialSource === "member" ? { credentialSource: parent.credentialSource } : {}),
    });
    if (!created.ok) return { error: `could not start the subagent's session: ${created.message}` };
    const made = created.events.find((stored) => stored.event.type === "thread.created")?.event;
    if (made?.type !== "thread.created" || !made.hash) return { error: "could not start the subagent's session" };
    const childId = made.threadId;
    const controller = new AbortController();
    if (signal.aborted) controller.abort();
    if (!request.background) {
      if (!signal.aborted) signal.addEventListener("abort", () => controller.abort(), { once: true, signal: controller.signal });
    }
    this.active.set(childId, { parentThreadId, controller });
    // A read-only session's questions are refused, not allowed.
    if (!request.readOnly) this.deps.allowAllFor(childId);
    this.deps.manage?.(childId);

    const subagentId = randomUUID();
    const started = Date.now();
    const onParent = (events: DomainEvent[]) =>
      this.deps.store
        .append(
          { projectId: parent.projectId, threadId: parentThreadId },
          events,
          events.every((event) => isTransient(event.type)) ? undefined : (tx) => applyProjection(tx, events, null),
        );
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
        background: request.background ?? false,
        ...(request.deliberationId ? { deliberationId: request.deliberationId } : {}),
        quota,
      },
    ]).catch((error: unknown) => { this.active.delete(childId); controller.abort(); this.deps.release?.(childId); throw error; });

    const childSignal = controller.signal;
    let provider = routing.provider;
    let currentModel = routing.model;
    let autoFallback = false;
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
      ]).catch(this.deps.onError);
    };
    const finish = async (outcome: RunOutcome) => {
      const status = outcome.kind === "done" ? "completed" : outcome.kind === "cancelled" ? "aborted" : "failed";
      const result = outcome.kind === "done" ? outcome.text : outcome.kind === "cancelled" && outcome.error === "the subagent was stopped" ? "Stopped." : outcome.error;
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
    const task = (text: string) => `${PREAMBLE}\n\n<task>\n${text.trim()}\n</task>`;

    let turnsRun = 0;
    const run = async (text: string): Promise<RunOutcome> => {
      const first = turnsRun++ === 0;
      const costBefore = costUsd;
      // The message; after a limit, the switch's own.
      let start: () => Promise<EngineResult> = () =>
        this.deps.dispatch(principal, {
          type: "thread.send",
          threadId: childId,
          text,
          provider,
          ...(currentModel ? { model: currentModel } : {}),
        });
      for (;;) {
        let outcome = await this.#childTurn(childId, principal, start, childSignal, {
          onTool: (name) => {
            toolCalls += 1;
            progress(name);
          },
          onText: (text) => progress(text),
        });
        if (outcome.kind === "done") {
          addUsage(usage, outcome.usage);
          costUsd += outcome.costUsd ?? 0;
          return { kind: "done", text: outcome.text, costUsd: costUsd - costBefore };
        }
        if (outcome.kind === "cancelled") {
          return { kind: "cancelled", error: "the subagent was stopped" };
        }
        const recoverable = outcome.kind === "limit" || (outcome.kind === "failed" && /model.*(?:not (?:found|available|supported)|unavailable|access|invalid)|(?:unknown|invalid|unsupported) model|not (?:logged|signed) in|authentication|unauthorized|token.*expired/i.test(outcome.error));
        if (recoverable && !autoFallback && (provider === "claude" || provider === "codex") && requestedModel) {
          autoFallback = true;
          const latest = await this.deps.harnesses(subject, requestedModel).catch(() => harnesses);
          const fallback = resolveHarness(requestedModel, {
            harnesses: latest.map((h) => ({ ...h, usable: h.provider === "omp" && h.usable })),
            catalogue: await this.deps.catalogue().catch(() => catalogue),
            parent: { provider, model: currentModel }, customProvider: "omp",
          });
          if (fallback.ok) {
            provider = fallback.provider;
            currentModel = fallback.model;
            await onParent([{ type: "agent.subagent_routed", threadId: parentThreadId, subagentId, provider,
              model: currentModel, routing: `${fallback.label}; automatic fallback: ${outcome.error}` }]);
            start = async () => {
              const [state] = await db.select({ provider: threads.provider }).from(threads).where(eq(threads.id, childId)).limit(1);
              if (!state?.provider) return this.deps.dispatch(principal, { type: "thread.send", threadId: childId,
                provider, ...(currentModel ? { model: currentModel } : {}), text });
              return this.deps.dispatch(principal, { type: "thread.switch_harness", threadId: childId,
                targetProvider: provider, ...(currentModel ? { model: currentModel } : {}), reason: "limit",
                message: first ? "Continue the assigned task from the handoff brief. Preserve completed work." : text });
            };
            continue;
          }
        }
        if (outcome.kind === "failed" && autoFallback && provider === "omp") outcome = { kind: "limit", error: `OpenRouter fallback failed: ${outcome.error}` };
        if (outcome.kind === "failed") return { kind: "failed", error: outcome.error };
        if (!request.attended) return { kind: "failed", error: outcome.error };

        // Its harness hit a usage limit: the person picks how it goes on.
        const requestId = randomUUID();
        const latest = await this.deps.harnesses(subject, requestedModel).catch(() => harnesses);
        await onParent([
          {
            type: "agent.choice_requested",
            threadId: parentThreadId,
            requestId,
            kind: "subagent_limit",
            title: `${harnessLabel(provider)} could not continue the subagent "${request.description}"`,
            detail: `${outcome.error} Carry on with another harness or model; completed work goes over as a brief.`,
            options: limitOptions(latest, provider),
            childThreadId: childId,
            subagentId,
            provider,
          },
        ]);
        const answer = await this.deps.choices.wait(requestId, childSignal);
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
          const why = childSignal.aborted ? "the subagent was stopped" : `${harnessLabel(provider)} hit its usage limit, and the subagent was not carried on`;
          return { kind: childSignal.aborted ? "cancelled" : "failed", error: why };
        }
        if (picked.id === "custom" && !answer.model) {
          return { kind: "failed", error: "no model was picked to carry the subagent on" };
        }
        provider = picked.provider;
        const model = answer.model ?? picked.model;
        currentModel = model ?? null;
        await onParent([{ type: "agent.subagent_routed", threadId: parentThreadId, subagentId, provider, model: currentModel, routing: `${model ?? "default model"} on ${harnessLabel(provider)} (manual recovery)` }]);
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
    };
    return {
      childId,
      hash: made.hash,
      subagentId,
      provider: routing.provider,
      model: routing.model,
      routing: routing.label,
      task,
      run,
      finish,
      abort: () => controller.abort(),
      close: () => {
        this.active.delete(childId);
        controller.abort();
        this.deps.release?.(childId);
      },
    };
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
