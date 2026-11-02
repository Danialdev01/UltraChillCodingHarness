import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { count, desc, eq } from "drizzle-orm";
import { projects, threads, turns, users, workspaces, type Database } from "@ucch/db";
import {
  DOCUMENTATION_RULES,
  HostExecutor,
  hostToolSchemas,
  invalidateTree,
  type HeavyJobGate,
  runTool,
  runTurn,
  type ApprovalDecision,
  type ApprovalRequest,
  type RegistryOptions,
  type DocumentsBackends,
  type ResearchBackends,
  type UploadStaging,
} from "@ucch/agent";
import {
  AgentPermissionMode,
  DEFAULT_AGENT_PERMISSION_MODE,
  effectiveCredentialSource,
  isTransient,
  isRiskyCommand,
  limitFallback,
  needsApproval,
  readAgentSettings,
  type CliProviderId,
  type Command,
  type DomainEvent,
  type MessageMode,
  type ProviderId,
  type ReasoningEffort,
  type TokenUsage,
  type WorkspaceAgentSettings,
} from "@ucch/protocol";
import {
  OMP_BRIDGE_READ_TOOLS,
  ompBridgeGuide,
  ompBridgeToolName,
  type AgentRun,
  type HostToolCall,
  type HostToolResult,
  type OmpMaintenanceInput,
  type OmpProvider,
  type OmpRunFiles,
  type ProviderRunInput,
} from "@ucch/providers";
import { detectStack } from "./clone.js";
import { decryptSecret } from "./crypto.js";
import { ensureProjectInfo, readProjectKnowledge } from "./dev-database.js";
import { workspaceSubject, type ProviderService } from "./providers.js";
import { toPolicy } from "./workspaces.js";
import { applyProjection } from "./engine.js";
import { treeFor, worktreeIdOf } from "./trees.js";
import type { Principal } from "./auth.js";
import type { EngineResult } from "./engine.js";
import { buildHandoffBrief, handoffMessage, handoffTitle, type BriefAsker } from "./omp-handoff.js";
import { messageText, RETAIN_PROMPT, retainStdin } from "./omp-memory.js";
import { runReview } from "./omp-review.js";
import { runGit } from "./git-exec.js";
import type { EventStore } from "./eventstore.js";
import { contextLengthFor, streamCompletion, supportsImages } from "./openrouter.js";
import { documentationPrompt } from "./documents.js";
import { briefedPrompt, EMPTY_BRIEF, researchAsk } from "./research.js";
import { DeltaCoalescer, isDelta } from "./delta-coalescer.js";
import { TurnScheduler, type TurnKind } from "./turn-scheduler.js";
import { DEFAULT_OMP_SETTINGS, writeOmpOverlay, type OmpPreset } from "./omp-overlay.js";
import { bridgeServer, writeClaudeMcpConfig, writeCodexBridge } from "./omp-bridge-config.js";
import type { ArgvWrapper } from "./child-priority.js";
import { registry as metrics } from "./metrics.js";

export interface AgentOptions {
  secretKey: string | undefined;
  defaultModel: string;
  /** For `web_search` and for compaction. Never the coding model. */
  searchModel: string;
  /** Host directory the project workspaces live under. */
  workspaceRoot: string;
  maxIterations: number;
  registry: RegistryOptions;
  /**
   * Attachment staging, for `attach_upload`. Optional so a harness can run
   * without it; the tool then says so rather than failing obscurely.
   */
  uploads?: UploadStaging;
  /**
   * The research pipeline's backends, for a turn sent in research mode.
   * Built once at boot from the server's configuration; the search half is
   * bound to each turn's own key inside the loop.
   */
  research: ResearchBackends;
  /**
   * The document pipeline -- the doc kit's path, its interpreter, and the
   * vision model -- for a turn sent in documentation mode.
   */
  documents: DocumentsBackends;
  /**
   * Where the native loop's document renders wait for one another: one gate
   * for the whole server, so `DOC_JOBS_MAX` holds across every turn.
   */
  heavyJobs?: HeavyJobGate;
  /** Puts the native loop's tool calls behind a lower priority (child-priority.ts). */
  wrapArgv?: ArgvWrapper;
  /**
   * The CLI providers. Optional so a harness can run with the native loop
   * alone; a turn that asks for one then fails with a message saying so.
   */
  providers?: ProviderService;
  /** False refuses `claude` and `codex` outright: see `cliProvidersEnabled`. */
  cliEnabled?: boolean;
  /**
   * Where turns wait for a slot (`turn-scheduler.ts`). Absent: two CLI turns
   * per account, and no limit beyond that.
   */
  scheduler?: TurnScheduler;
  /** How long streamed tokens are held to be sent together; see `DeltaCoalescer`. 40 ms when absent. */
  streamFlushMs?: number;
  /** Subagents one OMP turn may run at once (`OMP_WORKERS_PER_TURN`). 4 when absent. */
  ompWorkersPerTurn?: number;
  /** `OMP_ENABLED`: new "Custom" threads run on OMP; see `resolveProvider`. */
  ompEnabled?: boolean;
  /**
   * The engine, for what a handoff starts as the person who asked for it:
   * the new thread and its first message (solution §5.4). Without it a
   * handoff fails with why.
   */
  dispatch?: (principal: Principal, command: Command) => Promise<EngineResult>;
  /**
   * The OMP bridge (solution §10), offered to a Claude Code or Codex turn
   * when its workspace turns it on (`agent_settings.ompBridge`). Absent: never.
   */
  ompBridge?: OmpBridgeOptions;
}

/** What the server knows about the OMP bridge: where it is, and where its calls take a slot. */
export interface OmpBridgeOptions {
  /** `OMP_BRIDGE_BIN`. */
  bin: string;
  /** `OMP_BIN`: the `omp` each bridge call starts. */
  ompBin: string;
  /** The scheduler socket `leases` listens on. */
  socket: string;
  /** `OMP_BRIDGE_MAX_SECONDS`. */
  maxSeconds: number;
  /** One token per turn, revoked when it ends (`bridge-leases.ts`). */
  leases: { register(holder: { ownerId: string; threadId: string }): { token: string; revoke(): void } };
}

/** How a turn was asked for: carried on the command, not the event. */
interface TurnOptions {
  model?: string | undefined;
  effort?: ReasoningEffort | undefined;
  provider?: ProviderId | undefined;
  mode?: MessageMode | undefined;
}

/** The account a turn is billed to; see `#owner`. */
interface TurnOwner {
  id: string;
  openrouterKeyEncrypted: string | null;
  defaultModel: string | null;
  defaultProvider: string | null;
  agentPermissionMode: string | null;
}

/** How many turns pass between looks at a project's stack. */
export const STACK_RECHECK_TURNS = 5;

/** Whether the project's `turns`th turn is one after which its stack is looked at again. */
export function shouldRecheckStack(turns: number): boolean {
  return turns > 0 && turns % STACK_RECHECK_TURNS === 0;
}

/**
 * Which model a turn runs on.
 *
 * Narrowest first: what this turn asked for, then the account's default from
 * Settings, then the server's `DEFAULT_MODEL`. Empty strings count as absent,
 * because that is what a cleared field and an absent column both arrive as --
 * and a turn started against the model id `""` fails at OpenRouter with an
 * error nobody can place.
 */
export function resolveModel(
  requested: string | undefined,
  accountDefault: string | null,
  serverDefault: string,
): string {
  return requested?.trim() || accountDefault?.trim() || serverDefault;
}

/** Which of the scheduler's limits a provider's turn counts against. */
export function turnKindOf(provider: ProviderId): TurnKind {
  return provider === "native" ? "native" : provider === "omp" ? "omp" : "cli";
}

/**
 * Which backend a turn runs on.
 *
 * A bound thread wins over everything: its CLI session cannot move. Then
 * what the turn asked for, then the account's default, then the native loop.
 * `decide()` has already refused a request that disagrees with the binding,
 * so the first two never conflict by the time this runs.
 *
 * With `ompEnabled` (`OMP_ENABLED`), "Custom" is OMP: a thread not yet bound
 * that would start on the native loop starts on OMP instead. A thread
 * already bound to the native loop stays on it, because its history is the
 * native session log, which OMP cannot resume (solution §11).
 */
export function resolveProvider(
  requested: ProviderId | undefined,
  threadBound: string | null,
  accountDefault: string | null,
  options: { ompEnabled?: boolean } = {},
): ProviderId {
  const known = (value: string | null | undefined): ProviderId | null =>
    value === "native" || value === "claude" || value === "codex" || value === "omp" ? value : null;
  const bound = known(threadBound);
  if (bound) return bound;
  const chosen = known(requested) ?? known(accountDefault) ?? "native";
  return chosen === "native" && options.ompEnabled ? "omp" : chosen;
}

/**
 * The reactor that answers a user message.
 *
 * `decide()` records that the person said something; this is what happens
 * next. It runs after the transaction that appended `user.message` commits,
 * so the history it reads back already includes the message it is replying
 * to -- there is no ordering trick here, just the engine's guarantee.
 *
 * The turn itself lives in `@ucch/agent`. What stays here is everything the
 * loop must not know about: the database, the key, the event store, and the
 * workspace directory.
 */
/**
 * Subagents the turns ran (OMP OM5.4), counted as each ends: OMP's `task`
 * workers and Claude Code's `Agent` subagents, by provider and how they
 * ended. Named for OMP, whose worker fan-out is what it watches.
 */
const subagentsTotal = metrics.counter("omp_subagents_total", "Subagents agent turns ran, by provider and how they ended", [
  "provider",
  "status",
]);

export class AgentTurnReactor {
  /**
   * One controller per running turn.
   *
   * `thread.cancel` produces no side effect of its own -- the decision
   * records the request, and the reactor is handed the command, which is the
   * hook that reaches in here and stops the run. Cleared in `finally`, so a
   * finished turn never leaves a controller behind for the next one to abort.
   */
  readonly #running = new Map<string, AbortController>();

  /** CLI runs in flight, to kill on shutdown. */
  readonly #cliRuns = new Set<AgentRun>();

  /** The CLI run per thread, for delivering a permission answer to it. */
  readonly #cliByThread = new Map<string, AgentRun>();

  /**
   * Threads whose prompt someone answered with "Allow All": every later
   * question on them is allowed without asking. In memory on purpose -- it
   * is "this session", and a restart is a fair place for it to end.
   */
  readonly #allowAll = new Set<string>();

  /**
   * Questions a person has not answered yet, per thread: the native loop's,
   * which wait on a promise here, and the CLI's, which wait on its stdin.
   * "Allow All" answers every one of them, not only the one it was on.
   */
  readonly #nativePrompts = new Map<string, Map<string, (decision: ApprovalDecision) => void>>();
  readonly #cliPrompts = new Map<string, Set<string>>();

  readonly #scheduler: TurnScheduler;

  constructor(
    private readonly db: Database,
    private readonly store: EventStore,
    private readonly options: AgentOptions,
    private readonly onError: (error: unknown) => void,
  ) {
    this.#scheduler =
      options.scheduler ?? new TurnScheduler({ cliPerUser: 2, cliTotal: Infinity, nativeTotal: Infinity });
  }

  /**
   * Starts a turn for each user message, and stops one on a cancel.
   * `principal` is who dispatched the command: a handoff starts its new
   * thread as them.
   */
  react(command: Command, batch: readonly DomainEvent[], principal?: Principal): void {
    if (command.type === "thread.cancel") {
      // The loop notices between tool calls and unwinds itself; a tool
      // already dispatched still records its result rather than vanishing.
      this.#running.get(command.threadId)?.abort();
      return;
    }

    if (command.type === "thread.permission_reply") {
      // A reply to a prompt that is gone -- answered from another tab, or
      // the turn ended -- is dropped: the log already says what happened.
      const reply: ApprovalDecision = {
        behavior: command.behavior,
        ...(command.message ? { message: command.message } : {}),
      };
      if (command.scope === "session" && command.behavior === "allow") {
        this.#allowAll.add(command.threadId);
        this.#answerAll(command.threadId);
        return;
      }
      this.#answer(command.threadId, command.requestId, reply);
      return;
    }

    for (const event of batch) {
      if (event.type === "thread.compaction_requested") {
        void this.#compact(event.threadId, event.method, event.focus).catch(this.onError);
        continue;
      }
      if (event.type === "thread.handoff_requested") {
        void this.#handoffTo(event, principal).catch(this.onError);
        continue;
      }
      if (event.type === "review.requested") {
        void this.#review(event).catch(this.onError);
        continue;
      }
      if (event.type !== "user.message") continue;
      // The model and effort ride on the command rather than the event: they
      // are how this turn was asked for, not something that happened.
      const sent = command.type === "thread.send" ? command : undefined;
      void this.#run(
        event.threadId,
        event.text,
        {
          model: sent?.model,
          effort: sent?.effort,
          provider: sent?.provider,
          // From the event, not the command: it is recorded there, and a turn
          // replayed from the log runs the same pipeline the original did.
          mode: event.mode,
        },
        principal,
      ).catch(this.onError);
    }
  }

  /**
   * Lets every tool call on a thread run without asking, as "allow for this
   * session" does. For threads nobody is watching to answer -- the Tasks
   * board's -- where a question would leave the turn waiting for ever.
   */
  allowAllFor(threadId: string): void {
    this.#allowAll.add(threadId);
  }

  /** Delivers one answer to whichever runtime is waiting on it. */
  #answer(threadId: string, requestId: string, reply: ApprovalDecision): void {
    const native = this.#nativePrompts.get(threadId)?.get(requestId);
    if (native) {
      native(reply);
      return;
    }
    this.#cliByThread.get(threadId)?.answerPermission?.(requestId, reply);
  }

  /** Allows every question still open on a thread. */
  #answerAll(threadId: string): void {
    for (const resolve of [...(this.#nativePrompts.get(threadId)?.values() ?? [])]) {
      resolve({ behavior: "allow" });
    }
    const run = this.#cliByThread.get(threadId);
    for (const requestId of [...(this.#cliPrompts.get(threadId) ?? [])]) {
      run?.answerPermission?.(requestId, { behavior: "allow" });
    }
  }

  /** The mode a thread's next question is judged under. */
  #modeFor(threadId: string, owner: { agentPermissionMode: string | null }): AgentPermissionMode {
    if (this.#allowAll.has(threadId)) return "allow_all";
    const parsed = AgentPermissionMode.safeParse(owner.agentPermissionMode);
    return parsed.success ? parsed.data : DEFAULT_AGENT_PERMISSION_MODE;
  }

  /**
   * The native loop's gate. Under the thread's mode, either the call runs
   * at once or a person is asked: the question is recorded as
   * `agent.permission_requested` -- the same event a CLI's prompt becomes,
   * so the chat shows one card for both -- and the tool waits for the
   * answer. A cancelled turn resolves it as a deny.
   */
  async #approveNative(input: {
    threadId: string;
    turnId: string;
    owner: { agentPermissionMode: string | null };
    request: ApprovalRequest;
    signal: AbortSignal;
    append: (events: readonly DomainEvent[]) => Promise<unknown>;
  }): Promise<ApprovalDecision> {
    const { threadId, turnId, request } = input;
    const command = shellCommandOf(request.input);
    const mode = this.#modeFor(threadId, input.owner);
    if (!needsApproval(mode, { kind: request.permission, command })) return { behavior: "allow" };
    if (input.signal.aborted) return { behavior: "deny", message: "The turn was cancelled." };

    const requestId = randomUUID();
    let prompts = this.#nativePrompts.get(threadId);
    if (!prompts) {
      prompts = new Map();
      this.#nativePrompts.set(threadId, prompts);
    }
    const open = prompts;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const onAbort = () => resolve({ behavior: "deny", message: "The turn was cancelled." });
      input.signal.addEventListener("abort", onAbort, { once: true });
      open.set(requestId, (reply) => {
        input.signal.removeEventListener("abort", onAbort);
        resolve(reply);
      });
    });

    try {
      await input.append([
        {
          type: "agent.permission_requested",
          threadId,
          turnId,
          requestId,
          toolUseId: request.toolUseId,
          toolName: request.toolName,
          input: request.input,
          description: null,
        },
      ]);
      const reply = await decision;
      await input.append([
        { type: "agent.permission_resolved", threadId, turnId, requestId, behavior: reply.behavior },
      ]);
      return reply;
    } finally {
      open.delete(requestId);
      if (open.size === 0) this.#nativePrompts.delete(threadId);
    }
  }

  /** Whether a turn is in flight. For tests and for shutdown. */
  get activeTurns(): number {
    return this.#running.size;
  }

  /** Hard-stops every CLI run: the teardown path, not the stop button. */
  async killAll(): Promise<void> {
    await Promise.all([...this.#cliRuns].map((run) => run.kill().catch(() => {})));
  }

  /**
   * The turn a `user.message` asked for, from the queued thread it left.
   *
   * Registered before anything is awaited, so a `thread.cancel` that comes
   * while the thread is still `queued` finds the turn and stops it before it
   * opens.
   */
  async #run(threadId: string, text: string, options: TurnOptions, principal?: Principal): Promise<void> {
    const controller = new AbortController();
    this.#running.set(threadId, controller);
    let limited: ProviderId | undefined;
    try {
      limited = await this.#turn(threadId, text, options, controller);
    } finally {
      // Only if it is still ours: a turn that overran its own cancellation
      // must not clear a controller the next turn has already registered.
      if (this.#running.get(threadId) === controller) this.#running.delete(threadId);
    }
    // After the turn has let go of the thread: the handoff claims it anew.
    if (limited) await this.#handOffOnLimit(threadId, limited, text, principal);
  }

  /**
   * Automatic handoff on a usage limit (solution §5.4, OM4.6): a Claude Code
   * or Codex turn that failed on its plan's limit goes on in a new thread on
   * the workspace's fallback provider, which is asked the message that
   * failed. The workspace turns it on (`agent_settings.autoHandoff`).
   *
   * Once per chain: a thread that already handed off on a limit, or was
   * itself started by one, fails as it would without the setting. So a
   * fallback that is limited too stops there instead of handing back.
   */
  async #handOffOnLimit(threadId: string, provider: ProviderId, text: string, principal: Principal | undefined): Promise<void> {
    const dispatch = this.options.dispatch;
    if (!dispatch || !principal) return;
    const [row] = await this.db
      .select({ agent: workspaces.agentSettings })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(threads.id, threadId))
      .limit(1);
    const target = row ? limitFallback(readAgentSettings(row.agent), provider) : null;
    if (!target) return;
    const history = await this.store.threadHistory(threadId);
    if (history.some(({ event }) => event.type === "thread.handed_off" && event.reason === "limit")) return;
    const result = await dispatch(principal, {
      type: "thread.handoff_to",
      threadId,
      targetProvider: target,
      message: text,
      reason: "limit",
    });
    // Refused -- the thread was sent another message meanwhile, or its
    // worktree is gone: the failed turn already says what happened.
    if (!result.ok) this.onError(new Error(`automatic handoff of ${threadId} refused: ${result.message}`));
  }

  async #turn(
    threadId: string,
    text: string,
    { model, effort, provider: requestedProvider, mode }: TurnOptions,
    controller: AbortController,
  ): Promise<ProviderId | undefined> {
    const [thread] = await this.db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
    // Nothing to release: the thread, and its status, went with it.
    if (!thread) return;

    // Until `turn.started`, the thread is `queued` and refuses every other
    // message: each way out before it says so, or the thread stays stuck.
    const dequeue = (reason: "error" | "cancelled") => {
      const event: DomainEvent = { type: "turn.dequeued", threadId, reason };
      return this.store
        .append({ projectId: thread.projectId, threadId }, [event], (tx) => applyProjection(tx, [event], null))
        .then(() => {}, this.onError);
    };

    let project: { stack: string | null; agent?: unknown; ompTrusted?: boolean } | undefined;
    let owner: TurnOwner | null;
    try {
      // With the workspace's agent settings, which an OMP turn's overlay
      // reads, and the project's trust, which decides its LSP and debugger.
      [project] = await this.db
        .select({ stack: projects.stack, agent: workspaces.agentSettings, ompTrusted: projects.ompTrusted })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .where(eq(projects.id, thread.projectId))
        .limit(1);
      // Whose subscription pays, by the workspace's policy and what the
      // thread was started on -- not whoever sent this message. Read once,
      // before the turn opens, because the model it may name is recorded in
      // `turn.started`.
      owner = project ? await this.#owner(thread.projectId, thread) : null;
    } catch (error) {
      await dequeue("error");
      throw error;
    }
    if (!project || !owner) {
      await dequeue("error");
      return;
    }

    const turnId = randomUUID();
    const target = { projectId: thread.projectId, threadId };

    // A project session works in its own worktree; every other thread in
    // the project's checkout.
    const workspace = treeFor(this.options.workspaceRoot, thread.projectId, thread);
    // Its writes name the worktree, so a view of another tree skips them.
    const worktreeId = worktreeIdOf(this.options.workspaceRoot, { projectId: thread.projectId, tree: workspace });

    // The turn failed on its plan's usage limit (OM4.6): `#run` may hand it off.
    let limited = false;
    // Who runs it, once resolved below: the subagent count's label.
    let runsOn: ProviderId = "native";
    const write = (batch: readonly DomainEvent[]) => {
      if (batch.length === 0) return Promise.resolve([]);
      if (batch.some((event) => event.type === "agent.turn_failed" && event.limit)) limited = true;
      for (const event of batch) {
        if (event.type === "agent.subagent_finished") subagentsTotal.inc({ provider: runsOn, status: event.status });
      }
      const events = worktreeId
        ? batch.map((event) => (event.type === "file.changed" ? { ...event, worktreeId } : event))
        : batch;
      // The prompt's file tree is cached between turns, and this is the half
      // of its invalidation that is exact: everything the agent itself
      // writes, deletes or attaches passes through here. The tree's own TTL
      // covers what does not -- a terminal, a pull, the browser file API.
      if (events.some((event) => event.type === "file.changed")) invalidateTree(workspace);
      // A batch of nothing but transient events skips the projection, and
      // with it the empty transaction that would otherwise be opened once
      // per streamed token.
      const durable = events.some((event) => !isTransient(event.type));
      return this.store.append(
        target,
        events,
        durable ? (tx) => applyProjection(tx, events, null) : undefined,
      );
    };
    // Tokens go out in runs rather than one frame each. Native, CLI and
    // research turns all stream through here. Everything else flushes the
    // run first: a transient-only append publishes before it returns, with
    // no await on the way, so what was streamed before a tool call or the
    // turn's end reaches the wire before it.
    const coalescer = new DeltaCoalescer((delta) => void write([delta]).catch(this.onError), {
      flushMs: this.options.streamFlushMs ?? 40,
    });
    const append = (events: readonly DomainEvent[]) => {
      if (events.length > 0 && events.every(isDelta)) {
        for (const event of events) coalescer.push(event);
        return Promise.resolve([]);
      }
      coalescer.flush();
      return write(events);
    };

    let release: (() => void) | undefined;
    try {
      // Stopped while it waited: the turn never opens.
      if (controller.signal.aborted) {
        await dequeue("cancelled");
        return;
      }

      // First, and before anything that can fail slowly: this is what
      // inserts the `turns` row and moves the thread to `running`, so until
      // it lands no turn is recorded. A cancel from here on aborts the
      // controller, and the turn stops as soon as it runs.
      // The model is resolved here rather than at the call to `runTurn`
      // below so the event that opens the turn records what it was actually
      // billed against -- the `turns` row is what the usage breakdown reads.
      //
      // Three steps, narrowest first: what this turn asked for, then the
      // account's default from Settings, then the server's. A message sent
      // from the composer always names one; the fallbacks are for everything
      // that does not -- another client, or a turn started by the harness.
      const provider = resolveProvider(requestedProvider, thread.provider, owner.defaultProvider, {
        ompEnabled: this.options.ompEnabled ?? false,
      });
      runsOn = provider;

      // A slot, before the turn opens: over the server's limits the turn
      // waits here, with no `turns` row and nothing billed, and the thread
      // hears how many are ahead of it. Stopped while it waits, it never
      // opens. Given back in `finally`, however the turn ends.
      try {
        release = await this.#scheduler.acquire({
          ownerId: owner.id,
          kind: turnKindOf(provider),
          threadId,
          signal: controller.signal,
          onAhead: (ahead) => void write([{ type: "agent.queued", threadId, ahead }]).catch(this.onError),
        });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
        await dequeue("cancelled");
        return;
      }

      if (provider !== "native") {
        // A CLI provider names its own models; the OpenRouter defaults are
        // not for it. What the composer sent, or nothing -- the CLI's own.
        // OMP is the exception: it bills the account's OpenRouter key, so it
        // runs on an OpenRouter model resolved as a native turn's is, and
        // the turn records which.
        const cliModel = provider === "omp" ? resolveModel(model, owner.defaultModel, this.options.defaultModel) : model;
        await append([
          { type: "turn.started", threadId, turnId, provider, ...(cliModel ? { model: cliModel } : {}) },
        ]);

        // A research turn on a CLI is two phases under one turn id: the
        // pipeline runs first on OpenRouter -- the CLI has its own tools and
        // none of these -- and what it found is handed to the CLI with the
        // message. The phase's events land on the thread as they happen, so
        // the person watches the research before the CLI starts on it.
        //
        // OMP needs neither this nor the documentation prompt below: it is
        // given the pipeline's own tools as host tools, under the mode's
        // preset (solution §3.7), and does the research or the document
        // itself.
        let prompt = text;
        let researched: { usage: TokenUsage; costUsd: number } | undefined;
        if (mode === "research" && provider !== "omp") {
          const phase = await this.#researchPhase({
            threadId,
            turnId,
            projectId: thread.projectId,
            workspace,
            text,
            stack: project.stack,
            owner,
            signal: controller.signal,
            append,
          });
          prompt = phase.prompt;
          researched = phase;
          // Stopped during the research: the turn ends here, billed for the
          // phase, rather than starting a CLI nobody is waiting for.
          if (controller.signal.aborted) {
            await append([
              {
                type: "agent.turn_completed",
                threadId,
                turnId,
                stopReason: "cancelled",
                usage: phase.usage,
                costUsd: phase.costUsd,
              },
            ]);
            return;
          }
        }

        // A documentation turn on a CLI has no phase of its own: the CLI
        // has a shell, so it is handed the same scripts the native loop's
        // typed tools run, by path, with the rules that go with them.
        if (mode === "documentation" && provider !== "omp") {
          prompt = documentationPrompt(text, this.options.documents);
          await append([
            {
              type: "context.injected",
              threadId,
              source: "documentation",
              content: prompt.slice(text.trim().length).trim(),
            },
          ]);
        }

        await this.#runCli(provider, {
          ownerId: owner.id,
          owner,
          threadId,
          turnId,
          projectId: thread.projectId,
          workspace,
          text: prompt,
          resumeToken: thread.providerSessionId,
          model: cliModel,
          effort,
          signal: controller.signal,
          append,
          agentSettings: readAgentSettings(project.agent),
          trusted: project.ompTrusted === true,
          ...(mode ? { mode } : {}),
          ...(researched ? { researched } : {}),
        });
        // Claude Code and Codex are the subscriptions with a limit to hit.
        return limited && (provider === "claude" || provider === "codex") ? provider : undefined;
      }

      const resolvedModel = resolveModel(model, owner.defaultModel, this.options.defaultModel);
      await append([{ type: "turn.started", threadId, turnId, model: resolvedModel, provider }]);

      // Checked after the turn is open, so a missing key surfaces as a failed
      // turn in the conversation rather than as a message that was never
      // answered by anything.
      const apiKey = this.#decryptKey(owner.openrouterKeyEncrypted);

      // The clone reactor fills this in on `project.created`, but a turn
      // can start while that clone is still running, or after one that
      // failed. An empty directory makes the file tools behave sanely
      // rather than failing with an error about the harness's own layout.
      await this.#prepareWorkspace(workspace);

      const history = await this.store.threadHistory(threadId);

      // Looked up per turn rather than held: the model can change between
      // turns, and the catalogue behind this is cached anyway.
      const [contextLength, canSeeImages] = await Promise.all([
        contextLengthFor(resolvedModel),
        supportsImages(resolvedModel),
      ]);

      await runTurn({
        projectId: thread.projectId,
        threadId,
        turnId,
        apiKey,
        model: resolvedModel,
        // OpenRouter's scale stops at high; Claude Code's levels above it are
        // clamped here rather than sent on to be refused.
        ...(effort ? { effort: effort === "xhigh" || effort === "max" ? "high" : effort } : {}),
        history: history.map((row) => row.event),
        stack: project.stack,
        // The preset and the mode travel together: each mode's prompt
        // describes its own tools, and only its preset offers them.
        preset: mode ?? "standard",
        ...(mode === "research" ? { mode, research: this.options.research } : {}),
        ...(mode === "documentation" ? { mode, documents: this.options.documents } : {}),
        registry: this.options.registry,
        contextLength,
        supportsImages: canSeeImages,
        searchModel: this.options.searchModel,
        maxIterations: this.options.maxIterations,
        executor: new HostExecutor(workspace, { heavyJobs: this.options.heavyJobs, wrapArgv: this.options.wrapArgv }),
        ...(this.options.uploads ? { uploads: this.options.uploads } : {}),
        complete: streamCompletion,
        signal: controller.signal,
        approve: (request) =>
          this.#approveNative({
            threadId,
            turnId,
            owner,
            request,
            signal: controller.signal,
            append,
          }),
        append: async (events) => {
          await append(events);
        },
        publish: (event) => {
          void append([event]).catch(this.onError);
        },
        // A missed prompt cache is not the person's problem and must not
        // reach the thread; it is an operator's signal that the prefix
        // layout has stopped working.
        onDiagnostic: (message) => this.onError(new Error(message)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await append([{ type: "agent.turn_failed", threadId, turnId, error: message }]).catch(
        this.onError,
      );
    } finally {
      release?.();
      // The tail of the answer, should the turn have ended without anything
      // durable after its last token.
      coalescer.dispose();
      // After the turn, not during it: a slow disk must not hold the
      // conversation up, and a failure here is never the turn's.
      void this.#recheckStack(thread.projectId, workspace).catch(this.onError);
    }
  }

  /**
   * `thread.compact` / `thread.handoff` (solution §5.3): OMP's own command
   * on the thread's session, in a short process of its own, between turns.
   * No turn opens -- nothing is asked of the model but the summary -- so
   * what it made lands as a `context.injected` with no turn, which the chat
   * draws under the last answer, and the reading the meter shows after it.
   *
   * It takes an OMP slot like a turn, and a stop reaches it like a turn's
   * (`#running`). Every way out ends with `thread.compaction_finished`,
   * which is what frees the thread the request claimed.
   */
  async #compact(threadId: string, method: "compact" | "handoff", focus: string | undefined): Promise<void> {
    const controller = new AbortController();
    this.#running.set(threadId, controller);
    const [thread] = await this.db.select().from(threads).where(eq(threads.id, threadId)).limit(1).catch((error: unknown) => {
      this.#running.delete(threadId);
      throw error;
    });
    if (!thread) {
      this.#running.delete(threadId);
      return;
    }
    let made: DomainEvent[] = [];
    let error: string | undefined;
    let release: (() => void) | undefined;
    let overlay: { dispose(): Promise<void> } | undefined;
    try {
      const owner = await this.#owner(thread.projectId, thread);
      if (!owner) throw new Error("there is nobody to bill this thread to");
      if (!thread.providerSessionId) throw new Error("this thread has no OMP session to compact yet");
      const providers = this.options.providers;
      if (!providers || !this.options.cliEnabled) throw new Error("OMP is disabled on this server");
      // The key first: a missing one says where to add it.
      const openrouterKey = this.#decryptKey(owner.openrouterKeyEncrypted);
      release = await this.#scheduler.acquire({ ownerId: owner.id, kind: "omp", threadId, signal: controller.signal });
      // The model the session last ran on: the summary is written by it, as
      // one OMP made mid-turn would be.
      const [last] = await this.db
        .select({ model: turns.model })
        .from(turns)
        .where(eq(turns.threadId, threadId))
        .orderBy(desc(turns.seq))
        .limit(1);
      const model = last?.model ?? resolveModel(undefined, owner.defaultModel, this.options.defaultModel);
      const permissionMode = this.#modeFor(threadId, owner);
      const resolved = await providers.resolve(owner.id, "omp", { openrouterKey, ompPreset: "standard" });
      const provider = resolved.provider as { maintain?(input: OmpMaintenanceInput): Promise<DomainEvent[]> };
      if (!provider.maintain) throw new Error("this server's OMP provider cannot compact a session");
      const written = await writeOmpOverlay(providers.ompRunDir(owner.id), randomUUID(), {
        settings: { ...DEFAULT_OMP_SETTINGS, models: { default: model } },
        preset: "standard",
        permissionMode,
        // Untrusted whatever the project: compacting needs no language
        // server or debugger, so none of the repository's config runs.
        trusted: false,
        workersPerTurn: this.options.ompWorkersPerTurn ?? 4,
        webSearch: false,
        hostTools: [],
      });
      overlay = written;
      made = await provider.maintain({
        ctx: resolved.ctx(treeFor(this.options.workspaceRoot, thread.projectId, thread)),
        threadId,
        resumeToken: thread.providerSessionId,
        model,
        permissionMode,
        omp: {
          overlayPath: written.path,
          sessionDir: providers.ompSessionDir(owner.id, thread.projectId),
          guardHookPath: providers.ompGuardHook(owner.id),
          trusted: false,
          contextThreshold: written.contextThreshold,
        },
        method,
        ...(focus ? { focus } : {}),
        signal: controller.signal,
      });
    } catch (caught) {
      error = controller.signal.aborted ? "Stopped." : caught instanceof Error ? caught.message : String(caught);
    } finally {
      release?.();
      await overlay?.dispose().catch(this.onError);
      if (this.#running.get(threadId) === controller) this.#running.delete(threadId);
      const events: DomainEvent[] = [
        ...made,
        { type: "thread.compaction_finished", threadId, method, ...(error ? { error: error.slice(0, 2_000) } : {}) },
      ];
      await this.store
        .append({ projectId: thread.projectId, threadId }, events, (tx) => applyProjection(tx, events, null))
        .catch(this.onError);
    }
  }

  /**
   * A thread's work carried on in a new thread on another provider
   * (solution §5.4).
   *
   * 1. The brief: the thread's log as a transcript, on stdin to a one-shot
   *    `omp -p --no-session --no-tools` on the overlay's `smol` role --
   *    the server's compaction model, never the coding one. OMP writes it
   *    whichever providers are on either side, so it bills as an OMP call
   *    does: the account's OpenRouter key, and an OMP slot.
   * 2. A new thread in the same folder (`thread.create` with `worktreeOf`),
   *    linked from both ends by `thread.handed_off`.
   * 3. The brief as its first message, on `targetProvider`.
   *
   * The files are not touched: the new thread finds them as the old one
   * left them. The old thread is busy from the request until the new
   * thread's message is sent, and a stop ends the brief there.
   */
  async #handoffTo(
    event: Extract<DomainEvent, { type: "thread.handoff_requested" }>,
    principal: Principal | undefined,
  ): Promise<void> {
    const { threadId } = event;
    const controller = new AbortController();
    this.#running.set(threadId, controller);
    const [thread] = await this.db.select().from(threads).where(eq(threads.id, threadId)).limit(1).catch((error: unknown) => {
      this.#running.delete(threadId);
      throw error;
    });
    if (!thread) {
      this.#running.delete(threadId);
      return;
    }
    let handed: Extract<DomainEvent, { type: "thread.handed_off" }> | undefined;
    let error: string | undefined;
    let release: (() => void) | undefined;
    let overlay: { dispose(): Promise<void> } | undefined;
    const stopped = () => {
      if (controller.signal.aborted) throw new Error("Stopped.");
    };
    try {
      const dispatch = this.options.dispatch;
      if (!dispatch || !principal) throw new Error("this server cannot start a thread for a handoff");
      const owner = await this.#owner(thread.projectId, thread);
      if (!owner) throw new Error("there is nobody to bill this thread to");
      const providers = this.options.providers;
      if (!providers || !this.options.cliEnabled) throw new Error("a handoff's brief is written by OMP, which is disabled on this server");
      // The key first: a missing one says where to add it.
      const openrouterKey = this.#decryptKey(owner.openrouterKeyEncrypted);
      const history = await this.store.threadHistory(threadId);
      release = await this.#scheduler.acquire({ ownerId: owner.id, kind: "omp", threadId, signal: controller.signal });
      stopped();
      const resolved = await providers.resolve(owner.id, "omp", { openrouterKey, ompPreset: "standard" });
      const omp = resolved.provider as Partial<BriefAsker>;
      if (!omp.ask) throw new Error("this server's OMP provider cannot write a brief");
      const written = await writeOmpOverlay(providers.ompRunDir(owner.id), randomUUID(), {
        settings: { ...DEFAULT_OMP_SETTINGS, models: { default: this.options.searchModel } },
        preset: "standard",
        permissionMode: this.#modeFor(threadId, owner),
        // A brief runs `--no-tools`: nothing for a trusted project's config to add.
        trusted: false,
        workersPerTurn: this.options.ompWorkersPerTurn ?? 4,
        webSearch: false,
        hostTools: [],
      });
      overlay = written;
      const brief = await buildHandoffBrief({
        omp: omp as BriefAsker,
        ctx: resolved.ctx(treeFor(this.options.workspaceRoot, thread.projectId, thread)),
        files: { overlayPath: written.path, guardHookPath: providers.ompGuardHook(owner.id) },
        events: history.map((stored) => stored.event),
        ...(event.focus ? { focus: event.focus } : {}),
        signal: controller.signal,
      });
      // The slot was for OMP; the new thread's turn takes its own.
      release();
      release = undefined;
      stopped();

      const created = await dispatch(principal, {
        type: "thread.create",
        projectId: thread.projectId,
        title: handoffTitle(thread.title),
        worktreeOf: threadId,
        ...(thread.credentialSource === "member" || thread.credentialSource === "workspace"
          ? { credentialSource: thread.credentialSource }
          : {}),
      });
      if (!created.ok) throw new Error(`could not start the new thread: ${created.message}`);
      const made = created.events.find((stored) => stored.event.type === "thread.created")?.event;
      if (made?.type !== "thread.created" || !made.hash) throw new Error("could not start the new thread");
      handed = {
        type: "thread.handed_off",
        threadId,
        fromThreadId: threadId,
        fromHash: thread.hash,
        toThreadId: made.threadId,
        toHash: made.hash,
        targetProvider: event.targetProvider,
        brief,
        ...(event.reason ? { reason: event.reason } : {}),
      };
      // Linked before its first message, so the new thread's log opens
      // with where it came from.
      const linked: DomainEvent[] = [{ ...handed, threadId: made.threadId }];
      await this.store.append({ projectId: thread.projectId, threadId: made.threadId }, linked, (tx) =>
        applyProjection(tx, linked, null),
      );
      const sent = await dispatch(principal, {
        type: "thread.send",
        threadId: made.threadId,
        text: handoffMessage(brief, event.message),
        provider: event.targetProvider,
      });
      if (!sent.ok) {
        handed = undefined;
        throw new Error(`the new thread could not start: ${sent.message}`);
      }
    } catch (caught) {
      error = controller.signal.aborted ? "Stopped." : caught instanceof Error ? caught.message : String(caught);
    } finally {
      release?.();
      await overlay?.dispose().catch(this.onError);
      if (this.#running.get(threadId) === controller) this.#running.delete(threadId);
      const events: DomainEvent[] = [
        handed && !error ? handed : { type: "thread.handoff_failed", threadId, error: (error ?? "the handoff failed").slice(0, 2_000) },
      ];
      await this.store
        .append({ projectId: thread.projectId, threadId }, events, (tx) => applyProjection(tx, events, null))
        .catch(this.onError);
    }
  }

  /**
   * A code review by OMP's `reviewer` (solution §9, OM7.7): the changes
   * read from git in the reviewed tree -- the session's worktree, or the
   * project's checkout -- one unattended `omp --mode rpc` on the `review`
   * overlay, and its verdict as `review.completed`, or why not as
   * `review.failed`.
   *
   * Billed as an OMP run: a session's review to whoever its turns bill, a
   * checkout's to the person who asked. It takes an OMP slot, and nothing of
   * the repository's tooling config runs whatever the project's trust: a
   * review reads code and needs no language server or debugger.
   */
  async #review(event: Extract<DomainEvent, { type: "review.requested" }>): Promise<void> {
    const ids = { projectId: event.projectId, reviewId: event.reviewId, threadId: event.threadId, scope: event.scope, ref: event.ref };
    let done: Extract<DomainEvent, { type: "review.completed" }> | undefined;
    let error: string | undefined;
    let release: (() => void) | undefined;
    let overlay: { dispose(): Promise<void> } | undefined;
    try {
      const [project] = await this.db
        .select({ defaultBranch: projects.defaultBranch })
        .from(projects)
        .where(eq(projects.id, event.projectId))
        .limit(1);
      if (!project) throw new Error("the project is gone");
      const [thread] = event.threadId ? await this.db.select().from(threads).where(eq(threads.id, event.threadId)).limit(1) : [];
      if (event.threadId && !thread) throw new Error("the session is gone");
      const owner = await this.#owner(event.projectId, thread ?? { createdByUserId: event.requestedBy, credentialSource: null });
      if (!owner) throw new Error("there is nobody to bill this review to");
      const providers = this.options.providers;
      if (!providers || !this.options.cliEnabled) throw new Error("reviews run on OMP, which is disabled on this server");
      // The key first: a missing one says where to add it.
      const openrouterKey = this.#decryptKey(owner.openrouterKeyEncrypted);
      release = await this.#scheduler.acquire({ ownerId: owner.id, kind: "omp", threadId: event.reviewId });
      const model = resolveModel(undefined, owner.defaultModel, this.options.defaultModel);
      const resolved = await providers.resolve(owner.id, "omp", { openrouterKey, ompPreset: "standard" });
      const omp = resolved.provider as Partial<Pick<OmpProvider, "call">>;
      if (!omp.call) throw new Error("this server's OMP provider cannot run a review");
      const written = await writeOmpOverlay(providers.ompRunDir(owner.id), randomUUID(), {
        settings: { ...DEFAULT_OMP_SETTINGS, models: { default: model } },
        preset: "review",
        trusted: false,
        workersPerTurn: this.options.ompWorkersPerTurn ?? 4,
        webSearch: false,
        hostTools: [],
      });
      overlay = written;
      const tree = treeFor(this.options.workspaceRoot, event.projectId, thread ?? null);
      const ctx = resolved.ctx(tree);
      const outcome = await runReview({
        tree,
        git: async (argv, okExitCodes) => {
          try {
            return await runGit(argv, tree, 60_000, { read: true, ...(okExitCodes ? { okExitCodes } : {}) });
          } catch {
            return null;
          }
        },
        scope: event.scope,
        ref: event.ref,
        // A session's branch left its own base; the checkout's, the default branch.
        base: thread?.baseBranch ?? project.defaultBranch ?? null,
        ...(event.focus ? { focus: event.focus } : {}),
        call: (input) =>
          omp.call!({
            ctx,
            omp: { overlayPath: written.path, guardHookPath: providers.ompGuardHook(owner.id) },
            projectId: event.projectId,
            ...(event.threadId ? { threadId: event.threadId } : {}),
            callId: event.reviewId,
            model,
            ...input,
          }),
      });
      done = { type: "review.completed", ...ids, ...outcome, model };
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      release?.();
      await overlay?.dispose().catch(this.onError);
      const events: DomainEvent[] = [done && !error ? done : { type: "review.failed", ...ids, error: (error ?? "the review failed").slice(0, 2_000) }];
      await this.store
        .append({ projectId: event.projectId, threadId: event.threadId }, events, (tx) => applyProjection(tx, events, null))
        .catch(this.onError);
    }
  }

  /**
   * Looks at the project's stack again every `STACK_RECHECK_TURNS` turns,
   * so the sidebar's icon follows a project that has grown a framework or
   * changed language since it was cloned.
   *
   * The count is the project's turns in the database rather than one held
   * here, so a restart neither resets it nor checks twice. Read from the
   * turn's own tree -- a session's worktree is where its work is -- and
   * recorded only when the answer changed.
   */
  async #recheckStack(projectId: string, workspace: string): Promise<void> {
    const [row] = await this.db
      .select({ turns: count() })
      .from(turns)
      .innerJoin(threads, eq(turns.threadId, threads.id))
      .where(eq(threads.projectId, projectId));
    if (!shouldRecheckStack(Number(row?.turns ?? 0))) return;

    const stack = await detectStack(workspace);
    if (stack === "unknown") return;
    const [project] = await this.db
      .select({ stack: projects.stack })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project || project.stack === stack) return;

    const event: DomainEvent = { type: "project.stack_detected", projectId, stack };
    await this.store.append({ projectId, threadId: null }, [event], (tx) =>
      applyProjection(tx, [event], null),
    );
  }

  /**
   * The workspace as every turn expects to find it: there, and with its
   * `.ucch/INFO.md`. Run before every turn of every harness, which is what
   * gives a project made before `.ucch` existed its folder.
   *
   * Only once the checkout exists: `git clone` refuses a directory that is
   * not empty, so a `.ucch` written while the clone is still queued would
   * fail it -- and the clone writes the folder itself when it lands. A
   * `.ucch` the harness cannot write -- a symlink, a file of that name -- is
   * the operator's to hear about, not a reason to fail the person's turn.
   */
  async #prepareWorkspace(workspace: string): Promise<void> {
    await mkdir(workspace, { recursive: true });
    const cloned = await stat(join(workspace, ".git")).then(
      () => true,
      () => false,
    );
    if (cloned) await ensureProjectInfo(workspace).catch(this.onError);
  }

  /**
   * A turn under a vendor CLI.
   *
   * The provider spawns the process and hands back events already in the
   * harness's own vocabulary, so what remains here is what the native path
   * does around `runTurn`: the gate, the cancel hook, and writing
   * each event through the same `append` -- which is what keeps the file
   * tree cache and the projection honest for both.
   *
   * An OMP turn takes the same path with three things more: the account's
   * OpenRouter key, decrypted for this one process; the turn's overlay
   * (`omp-overlay.ts`), written before the spawn and deleted after it,
   * however the turn ends; and the UCCH section of its system prompt.
   */
  async #runCli(
    provider: CliProviderId,
    input: {
      ownerId: string;
      owner: { agentPermissionMode: string | null; openrouterKeyEncrypted: string | null; defaultModel: string | null };
      threadId: string;
      turnId: string;
      projectId: string;
      workspace: string;
      text: string;
      resumeToken: string | null;
      model: string | undefined;
      effort: ReasoningEffort | undefined;
      signal: AbortSignal;
      append: (events: readonly DomainEvent[]) => Promise<unknown>;
      /** The workspace's choices; OMP's overlay reads them. Defaults when absent. */
      agentSettings?: WorkspaceAgentSettings;
      /**
       * The project is trusted (`projects.omp_trusted`, solution §0.3): an
       * OMP turn, and the bridge's calls, get its language servers and the
       * debugger. Untrusted when absent.
       */
      trusted?: boolean;
      /** The composer mode. Only OMP reads it: the CLIs' prompt already carries it. */
      mode?: MessageMode;
      /**
       * What a research phase already spent on this turn. Folded into the
       * CLI's `agent.turn_completed`, which is the one event the usage
       * breakdown reads -- a phase that closed the turn itself would have
       * moved the thread to idle with the CLI still to run.
       */
      researched?: { usage: TokenUsage; costUsd: number };
    },
  ): Promise<void> {
    if (!this.options.providers || !this.options.cliEnabled) {
      throw new Error(
        `The ${provider} provider is disabled on this server. It runs the CLI on the host, so it needs AGENT_ALLOW_HOST_SHELL like the terminal does.`,
      );
    }

    // Before anything else, so a missing key fails the turn at once with
    // the message that says where to add one.
    const openrouterKey = provider === "omp" ? this.#decryptKey(input.owner.openrouterKeyEncrypted) : undefined;

    let run: AgentRun | undefined;
    let overlay: { dispose(): Promise<void> } | undefined;
    let bridge: (Pick<ProviderRunInput, "mcpConfigPath" | "codexMcp"> & { dispose(): Promise<void> }) | null = null;
    try {
      await this.#prepareWorkspace(input.workspace);
      const knowledge = await readProjectKnowledge(input.workspace).catch((error: unknown) => {
        this.onError(error);
        return null;
      });
      // Before the instructions: whether the turn has the bridge decides
      // whether they carry its guide.
      if (provider !== "omp" && input.agentSettings?.ompBridge.enabled) bridge = await this.#openBridge(provider, input);
      // When to reach for the bridge's tools (solution §10.4). Codex reads
      // instructions only at the start of a session (`codexPrompt`), so a
      // resumed Codex turn is not handed it, and the log does not say so.
      const guide = bridge && !(provider === "codex" && input.resumeToken) ? ompBridgeGuide() : null;
      // OMP is handed the knowledge inside its own section of the system
      // prompt (solution §3.8). It reads the worktree's AGENTS.md itself, so
      // that is never added here.
      const instructions =
        provider === "omp"
          ? ompInstructions(input.workspace, knowledge, input.mode)
          : guide
            ? [knowledge?.trimEnd(), guide].filter((part): part is string => Boolean(part)).join("\n\n")
            : knowledge;
      // Logged as the native loop logs its prompt parts, so the thread says
      // exactly what the CLI was handed on top of the message: for OMP the
      // whole appended prompt, byte for byte.
      if (provider === "omp") {
        await input.append([
          { type: "context.injected", threadId: input.threadId, source: "system_prompt", content: instructions! },
        ]);
      } else {
        if (knowledge) {
          await input.append([
            { type: "context.injected", threadId: input.threadId, source: "project_context", content: knowledge },
          ]);
        }
        if (guide) {
          await input.append([{ type: "context.injected", threadId: input.threadId, source: "omp_bridge", content: guide }]);
        }
      }
      // The mode's tools and rules (solution §3.7); the guard hook reads it
      // too, to keep a documentation turn's writes under docs/.
      const preset: OmpPreset = input.mode ?? "standard";
      const resolved = await this.options.providers.resolve(
        input.ownerId,
        provider,
        openrouterKey ? { openrouterKey, ompPreset: preset } : {},
      );
      const permissionMode = this.#modeFor(input.threadId, input.owner);
      let omp: OmpRunFiles | undefined;
      let host: Pick<ProviderRunInput, "hostTools" | "onHostToolCall"> = {};
      if (provider === "omp") {
        const providers = this.options.providers;
        const hostTools = hostToolSchemas(preset, this.options.registry);
        // One bank per project, under the subject that pays (solution §7.1).
        const memory = input.agentSettings?.memory ?? DEFAULT_OMP_SETTINGS.memory;
        const written = await writeOmpOverlay(providers.ompRunDir(input.ownerId), input.turnId, {
          // Every model role is the turn's model until the workspace picks
          // its own (OM8.1): a role left unnamed is the repository's to set.
          settings: {
            ...DEFAULT_OMP_SETTINGS,
            models: input.model ? { default: input.model } : {},
            isolatedFanOut: input.agentSettings?.isolatedFanOut.enabled ?? false,
            memory,
          },
          ...(memory.enabled ? { memoryDbPath: providers.ompMemoryDb(input.ownerId, input.projectId) } : {}),
          preset,
          permissionMode,
          // A trusted project keeps its debugger (§0.3); its LSP is the argv's.
          trusted: input.trusted === true,
          workersPerTurn: this.options.ompWorkersPerTurn ?? 4,
          // OMP's own search needs a search provider's key, and its
          // environment carries the OpenRouter key alone (solution §3.3).
          webSearch: false,
          hostTools: hostTools.map((tool) => tool.name),
        });
        overlay = written;
        omp = {
          overlayPath: written.path,
          sessionDir: providers.ompSessionDir(input.ownerId, input.projectId),
          guardHookPath: providers.ompGuardHook(input.ownerId),
          trusted: input.trusted === true,
          contextThreshold: written.contextThreshold,
        };
        host = {
          hostTools,
          onHostToolCall: (call, signal) =>
            this.#runHostTool(call, signal, {
              ...input,
              preset,
              advertised: new Set(hostTools.map((tool) => tool.name)),
              apiKey: openrouterKey!,
            }),
        };
      }
      run = resolved.provider.run({
        ctx: resolved.ctx(input.workspace),
        prompt: input.text,
        projectId: input.projectId,
        threadId: input.threadId,
        turnId: input.turnId,
        ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        permissionMode,
        ...(instructions ? { instructions } : {}),
        ...(omp ? { omp } : {}),
        ...(bridge?.mcpConfigPath ? { mcpConfigPath: bridge.mcpConfigPath } : {}),
        ...(bridge?.codexMcp ? { codexMcp: bridge.codexMcp } : {}),
        ...host,
      });
      this.#cliRuns.add(run);
      this.#cliByThread.set(input.threadId, run);

      // The stop button is SIGINT: the CLI ends the turn and records what
      // it managed. SIGTERM would strand the turn unfinished (see `killAll`).
      const current = run;
      const onAbort = () => void current.interrupt().catch(this.onError);
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();

      // Prompts the harness answered itself never reach the log: the CLI
      // asked because its own mode is coarser than the account's, not
      // because a person needs to see anything.
      const autoAnswered = new Set<string>();
      const open = new Set<string>();
      this.#cliPrompts.set(input.threadId, open);
      // The turn's final answer, for end-of-turn retention (OM7.2).
      let answer: string | null = null;
      let completed = false;
      try {
        for await (const event of run.events) {
          if (event.type === "agent.message") answer = messageText(event.content) ?? answer;
          else if (event.type === "agent.turn_completed") completed = true;
          if (event.type === "agent.permission_requested") {
            const mode = this.#modeFor(input.threadId, input.owner);
            const needsPerson =
              provider === "omp"
                ? ompPromptNeedsPerson(mode, event.toolName, event.input)
                : claudePromptNeedsPerson(mode, event.toolName, event.input);
            if (
              !needsPerson &&
              current.answerPermission?.(event.requestId, { behavior: "allow" })
            ) {
              autoAnswered.add(event.requestId);
              continue;
            }
            open.add(event.requestId);
          } else if (event.type === "agent.permission_resolved") {
            open.delete(event.requestId);
            if (autoAnswered.delete(event.requestId)) continue;
          }
          if (isTransient(event.type)) {
            // Not awaited, like the loop's `publish`: a token is not worth
            // holding the stream for.
            void input.append([event]).catch(this.onError);
          } else if (event.type === "agent.turn_completed" && input.researched) {
            await input.append([withResearchUsage(event, input.researched)]);
          } else {
            await input.append([event]);
          }
        }
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        if (this.#cliPrompts.get(input.threadId) === open) this.#cliPrompts.delete(input.threadId);
      }
      const memory = input.agentSettings?.memory;
      if (provider !== "omp" && completed && answer && memory?.enabled && memory.retainCliTurns) {
        // After the turn, on a slot of its own: the thread never waits on it.
        void this.#retainAnswer({ ...input, answer }).catch(this.onError);
      }
    } finally {
      if (run) {
        this.#cliRuns.delete(run);
        if (this.#cliByThread.get(input.threadId) === run) this.#cliByThread.delete(input.threadId);
      }
      // The events end when the process has exited, so nothing reads the
      // overlay any more. A failure to delete it is the operator's to hear.
      await overlay?.dispose().catch(this.onError);
      await bridge?.dispose().catch(this.onError);
    }
  }

  /**
   * End-of-turn retention (solution §7.3, OM7.2): a Claude Code or Codex
   * turn's final answer read by OMP's `smol` role with only the `retain`
   * tool, under an overlay naming the project's bank, so a decision made in
   * one provider's thread is recalled in another's. Billed to the
   * OpenRouter key, on an OMP slot; nothing without a key.
   */
  async #retainAnswer(input: {
    ownerId: string;
    owner: { openrouterKeyEncrypted: string | null; defaultModel: string | null };
    projectId: string;
    threadId: string;
    workspace: string;
    agentSettings?: WorkspaceAgentSettings;
    answer: string;
  }): Promise<void> {
    const providers = this.options.providers;
    if (!providers) return;
    let openrouterKey: string;
    try {
      openrouterKey = this.#decryptKey(input.owner.openrouterKeyEncrypted);
    } catch {
      return;
    }
    const release = await this.#scheduler.acquire({ ownerId: input.ownerId, kind: "omp", threadId: input.threadId });
    let overlay: { dispose(): Promise<void> } | undefined;
    try {
      const resolved = await providers.resolve(input.ownerId, "omp", { openrouterKey, ompPreset: "standard" });
      const omp = resolved.provider as Partial<BriefAsker>;
      if (!omp.ask) return;
      const written = await writeOmpOverlay(providers.ompRunDir(input.ownerId), randomUUID(), {
        settings: {
          ...DEFAULT_OMP_SETTINGS,
          models: { default: resolveModel(undefined, input.owner.defaultModel, this.options.defaultModel) },
          memory: input.agentSettings?.memory ?? DEFAULT_OMP_SETTINGS.memory,
        },
        memoryDbPath: providers.ompMemoryDb(input.ownerId, input.projectId),
        memoryToolsOnly: true,
        preset: "standard",
        // Nobody to ask, and `retain` is its only tool, so untrusted always.
        permissionMode: "allow_all",
        trusted: false,
        workersPerTurn: 1,
        webSearch: false,
        hostTools: [],
      });
      overlay = written;
      await omp.ask({
        ctx: resolved.ctx(input.workspace),
        omp: { overlayPath: written.path, guardHookPath: providers.ompGuardHook(input.ownerId) },
        prompt: RETAIN_PROMPT,
        stdin: retainStdin(input.answer),
        model: "@smol",
        tools: ["retain"],
      });
    } finally {
      release();
      await overlay?.dispose().catch(this.onError);
    }
  }

  /**
   * The OMP bridge for one Claude Code or Codex turn (solution §10.3): its
   * overlay, a scheduler token, and the MCP config that hands both to the
   * bridge, with the OpenRouter key its calls are billed to -- Claude
   * Code's `--mcp-config` file, or for Codex the `-c` flags and the 0600
   * file they name. Disposing deletes the files and revokes the token; a
   * bridge still running then gets no slot.
   *
   * Null -- the turn runs without the bridge -- when the server has no
   * bridge, or there is no key to bill it to: the tools are an extra, and
   * the CLI is on its subscription whether they are there or not.
   */
  async #openBridge(
    provider: "claude" | "codex",
    input: {
      ownerId: string;
      owner: { openrouterKeyEncrypted: string | null; defaultModel: string | null };
      projectId: string;
      threadId: string;
      turnId: string;
      workspace: string;
      agentSettings?: WorkspaceAgentSettings;
      trusted?: boolean;
    },
  ): Promise<(Pick<ProviderRunInput, "mcpConfigPath" | "codexMcp"> & { dispose(): Promise<void> }) | null> {
    const options = this.options.ompBridge;
    const providers = this.options.providers;
    if (!options || !providers) return null;
    let openrouterKey: string;
    try {
      openrouterKey = this.#decryptKey(input.owner.openrouterKeyEncrypted);
    } catch {
      return null;
    }
    const memory = input.agentSettings?.memory ?? DEFAULT_OMP_SETTINGS.memory;
    const disposers: (() => Promise<void> | void)[] = [];
    const dispose = async () => {
      for (const step of disposers.splice(0).reverse()) await step();
    };
    try {
      const overlay = await writeOmpOverlay(providers.ompRunDir(input.ownerId), `bridge-${input.turnId}`, {
        // Each call names a role (`@smol`, `@slow`); every role is the
        // account's OpenRouter model until the workspace picks its own.
        settings: {
          ...DEFAULT_OMP_SETTINGS,
          models: { default: resolveModel(undefined, input.owner.defaultModel, this.options.defaultModel) },
          memory,
        },
        // The project's bank, as its OMP turns have it (OM7.2).
        ...(memory.enabled ? { memoryDbPath: providers.ompMemoryDb(input.ownerId, input.projectId), memoryToolsOnly: true } : {}),
        preset: "standard",
        // A bridge call has no one to ask: its `omp` runs headless, under
        // `--approval-mode yolo`. The person is asked by Claude Code, about
        // the bridge tool itself (`claudePromptNeedsPerson`), before the
        // call starts.
        permissionMode: "allow_all",
        // As the project is: a trusted one's calls get `lsp` and `debug`.
        trusted: input.trusted === true,
        // A call is one tool call of a turn, not a turn: two subagents.
        workersPerTurn: 2,
        webSearch: false,
      });
      disposers.push(() => overlay.dispose());
      const lease = options.leases.register({ ownerId: input.ownerId, threadId: input.threadId });
      disposers.push(() => lease.revoke());
      const server = bridgeServer({
        node: process.execPath,
        bridgeBin: options.bin,
        ompBin: options.ompBin,
        agentDir: providers.ompAgentDir(input.ownerId),
        overlay: overlay.path,
        openrouterKey,
        worktree: input.workspace,
        schedulerSock: options.socket,
        token: lease.token,
        maxSeconds: options.maxSeconds,
        trusted: input.trusted === true,
        memory: memory.enabled,
      });
      const runDir = providers.cliRunDir(input.ownerId, provider);
      if (provider === "codex") {
        const codex = await writeCodexBridge(runDir, input.turnId, server, options.maxSeconds);
        disposers.push(() => codex.dispose());
        return { codexMcp: codex.mcp, dispose };
      }
      const config = await writeClaudeMcpConfig(runDir, input.turnId, server);
      disposers.push(() => config.dispose());
      return { mcpConfigPath: config.path, dispose };
    } catch (error) {
      await dispose().catch(this.onError);
      throw error;
    }
  }

  /**
   * One call an OMP turn made to a host tool (solution §3.7), run by
   * `runTool` exactly as a native turn runs it: the preset's tool, its
   * arguments repaired and checked, the thread's approval gate, a deadline,
   * and the executor's confinement to the worktree. What the tool emits --
   * a changed file, an upload, a document -- lands on the thread as a native
   * turn's would. The call's own `agent.tool_use` / `agent.tool_result` come
   * from OMP's frames, not from here.
   *
   * `signal` is OMP's cancel; the turn's stop button reaches the tool too.
   */
  async #runHostTool(
    call: HostToolCall,
    signal: AbortSignal,
    input: {
      threadId: string;
      turnId: string;
      projectId: string;
      workspace: string;
      model: string | undefined;
      owner: { agentPermissionMode: string | null };
      signal: AbortSignal;
      append: (events: readonly DomainEvent[]) => Promise<unknown>;
      preset: OmpPreset;
      advertised: ReadonlySet<string>;
      apiKey: string;
    },
  ): Promise<HostToolResult> {
    // OMP only calls what it was offered; this keeps it so if it ever does not.
    if (!input.advertised.has(call.toolName)) {
      return { content: `There is no host tool called ${JSON.stringify(call.toolName)}.`, isError: true };
    }
    const turnSignal = AbortSignal.any([input.signal, signal]);
    const model = input.model ?? this.options.defaultModel;
    const outcome = await runTool(
      { id: call.toolCallId, type: "function", function: { name: call.toolName, arguments: JSON.stringify(call.arguments) } },
      {
        projectId: input.projectId,
        threadId: input.threadId,
        turnId: input.turnId,
        apiKey: input.apiKey,
        model,
        searchModel: this.options.searchModel,
        preset: input.preset,
        registry: this.options.registry,
        executor: new HostExecutor(input.workspace, { heavyJobs: this.options.heavyJobs, wrapArgv: this.options.wrapArgv }),
        complete: streamCompletion,
        signal: turnSignal,
        ...(this.options.uploads ? { uploads: this.options.uploads } : {}),
        // The pipelines' backends, bound to this turn's key inside runTool.
        ...(input.preset === "research" ? { mode: "research" as const, research: this.options.research } : {}),
        ...(input.preset === "documentation" ? { mode: "documentation" as const, documents: this.options.documents } : {}),
        approve: (request) =>
          this.#approveNative({
            threadId: input.threadId,
            turnId: input.turnId,
            owner: input.owner,
            request,
            signal: turnSignal,
            append: input.append,
          }),
        append: async (events) => {
          await input.append(events);
        },
      },
    );
    return { content: outcome.content, isError: outcome.isError };
  }

  /**
   * The research pipeline as the first phase of a CLI provider's turn.
   *
   * Runs the native loop with the research preset, on the account's default
   * model from Settings (or the server's) -- the model the composer named
   * is the CLI's and means nothing to OpenRouter. The turn is left open:
   * the CLI closes it. The brief is recorded as `context.injected` so the
   * log says what the CLI was handed, and the phase's spend is returned to
   * be folded into the CLI's completion event.
   *
   * A phase that cannot run -- no key, a failed loop -- fails the turn,
   * which is the right outcome: the person asked for research, and a CLI
   * answering without any would look like it had been done.
   */
  async #researchPhase(input: {
    threadId: string;
    turnId: string;
    projectId: string;
    workspace: string;
    text: string;
    stack: string | null;
    owner: { openrouterKeyEncrypted: string | null; defaultModel: string | null };
    signal: AbortSignal;
    append: (events: readonly DomainEvent[]) => Promise<unknown>;
  }): Promise<{ prompt: string; usage: TokenUsage; costUsd: number }> {
    const apiKey = this.#decryptKey(input.owner.openrouterKeyEncrypted);
    const model = resolveModel(undefined, input.owner.defaultModel, this.options.defaultModel);
    await this.#prepareWorkspace(input.workspace);

    // The thread's earlier asks, for a follow-up to follow on from. Only
    // what the person typed: the CLI's own events are not replayable here.
    const history = await this.store.threadHistory(input.threadId);
    const asks = history
      .map((row) => row.event)
      .filter((event) => event.type === "user.message")
      .map((event) => event.text);
    // The last one is the message this turn answers.
    const earlier = asks.slice(0, -1);

    const [contextLength, canSeeImages] = await Promise.all([
      contextLengthFor(model),
      supportsImages(model),
    ]);

    const outcome = await runTurn({
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: input.turnId,
      apiKey,
      model,
      history: [
        {
          type: "user.message",
          threadId: input.threadId,
          text: researchAsk(input.text, earlier),
        },
      ],
      stack: input.stack,
      preset: "research",
      mode: "research",
      research: this.options.research,
      registry: this.options.registry,
      contextLength,
      supportsImages: canSeeImages,
      searchModel: this.options.searchModel,
      maxIterations: this.options.maxIterations,
      executor: new HostExecutor(input.workspace, { heavyJobs: this.options.heavyJobs, wrapArgv: this.options.wrapArgv }),
      complete: streamCompletion,
      signal: input.signal,
      conclude: false,
      append: async (events) => {
        await input.append(events);
      },
      publish: (event) => {
        void input.append([event]).catch(this.onError);
      },
      onDiagnostic: (message) => this.onError(new Error(message)),
    });

    const brief = outcome.text.trim() || EMPTY_BRIEF;
    const prompt = briefedPrompt(input.text, brief, model);
    await input.append([
      {
        type: "context.injected",
        threadId: input.threadId,
        source: "research",
        content: brief,
      },
    ]);

    return { prompt, usage: outcome.usage, costUsd: outcome.costUsd };
  }

  /**
   * A one-off read-only run over a project's checkout, outside any thread:
   * the documentation page's "Update with AI".
   *
   * On the account's default model from Settings (or the server's), with the
   * native loop and the `readonly` preset, so it can look at every file and
   * change none. The thread and turn ids are made up for the loop's own
   * bookkeeping, and its events are dropped rather than appended: nothing of
   * this belongs in a conversation. The caller parses the reply.
   */
  async generateFromCodebase(input: {
    projectId: string;
    stack: string | null;
    ask: string;
    signal: AbortSignal;
  }): Promise<{ text: string; model: string; usage: TokenUsage; costUsd: number }> {
    const owner = await this.#owner(input.projectId);
    if (!owner) throw new Error("project not found");
    const apiKey = this.#decryptKey(owner.openrouterKeyEncrypted);
    const model = resolveModel(undefined, owner.defaultModel, this.options.defaultModel);
    const workspace = join(this.options.workspaceRoot, input.projectId);
    await this.#prepareWorkspace(workspace);

    const threadId = randomUUID();
    const [contextLength, canSeeImages] = await Promise.all([
      contextLengthFor(model),
      supportsImages(model),
    ]);

    // A loop like a native turn's, so it takes a native turn's slot.
    const release = await this.#scheduler.acquire({
      ownerId: owner.id,
      kind: "native",
      threadId,
      signal: input.signal,
    });
    let outcome: Awaited<ReturnType<typeof runTurn>>;
    try {
      outcome = await runTurn({
        projectId: input.projectId,
        threadId,
        turnId: randomUUID(),
        apiKey,
        model,
        history: [{ type: "user.message", threadId, text: input.ask }],
        stack: input.stack,
        preset: "readonly",
        registry: this.options.registry,
        contextLength,
        supportsImages: canSeeImages,
        searchModel: this.options.searchModel,
        maxIterations: this.options.maxIterations,
        executor: new HostExecutor(workspace, { heavyJobs: this.options.heavyJobs, wrapArgv: this.options.wrapArgv }),
        complete: streamCompletion,
        signal: input.signal,
        conclude: false,
        append: async () => {},
        publish: () => {},
        onDiagnostic: (message) => this.onError(new Error(message)),
      });
    } finally {
      release();
    }

    return { text: outcome.text, model, usage: outcome.usage, costUsd: outcome.costUsd };
  }

  /**
   * What a turn is billed to and configured by.
   *
   * `id` is the credential subject the CLI logins live under: a user id for
   * a member's own subscription, `ws-<id>` for the workspace's dedicated
   * one. The preferences -- model, provider, permission mode -- are always
   * a person's: the thread's starter, or for an older thread (and for work
   * with no thread) the project's creator.
   *
   * Null only when the project has no row to join, which means it was
   * deleted between the message and this.
   */
  async #owner(
    projectId: string,
    thread?: { createdByUserId: string | null; credentialSource: string | null },
  ): Promise<TurnOwner | null> {
    const [project] = await this.db
      .select({
        creator: projects.userId,
        workspaceId: workspaces.id,
        policy: workspaces.credentialPolicy,
        workspaceKey: workspaces.openrouterKeyEncrypted,
      })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return null;

    const personId = thread?.createdByUserId ?? project.creator;
    const [person] = await this.db
      .select({
        id: users.id,
        openrouterKeyEncrypted: users.openrouterKeyEncrypted,
        defaultModel: users.defaultModel,
        defaultProvider: users.defaultProvider,
        agentPermissionMode: users.agentPermissionMode,
      })
      .from(users)
      .where(eq(users.id, personId))
      .limit(1);
    if (!person) return null;

    const bound = thread?.credentialSource === "workspace" || thread?.credentialSource === "member"
      ? thread.credentialSource
      : null;
    if (effectiveCredentialSource(toPolicy(project.policy), bound) === "workspace") {
      return {
        ...person,
        id: workspaceSubject(project.workspaceId),
        openrouterKeyEncrypted: project.workspaceKey,
      };
    }
    return person;
  }

  /** The stored key in the clear, for exactly this turn. */
  #decryptKey(encrypted: string | null): string {
    if (!this.options.secretKey) {
      throw new Error("SECRET_KEY is not configured, so no stored key can be decrypted");
    }
    if (!encrypted) {
      throw new Error("No OpenRouter API key is set. Add one in Settings -- or, when this workspace uses its own subscription, in Workspace settings -> Harness -- to talk to the agent.");
    }
    return decryptSecret(encrypted, this.options.secretKey);
  }
}

/** The CLI's completion, with what the research phase spent added on. */
export function withResearchUsage(
  event: Extract<DomainEvent, { type: "agent.turn_completed" }>,
  researched: { usage: TokenUsage; costUsd: number },
): Extract<DomainEvent, { type: "agent.turn_completed" }> {
  return {
    ...event,
    usage: {
      inputTokens: event.usage.inputTokens + researched.usage.inputTokens,
      outputTokens: event.usage.outputTokens + researched.usage.outputTokens,
      cacheReadInputTokens: event.usage.cacheReadInputTokens + researched.usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        event.usage.cacheCreationInputTokens + researched.usage.cacheCreationInputTokens,
    },
    costUsd: event.costUsd + researched.costUsd,
  };
}

/** Claude Code's tools that change files; `acceptEdits` covers them inside the workspace. */
const CLAUDE_EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** The OMP bridge's read-only tools, as Claude Code names them. */
const OMP_BRIDGE_READS: ReadonlySet<string> = new Set(OMP_BRIDGE_READ_TOOLS.map(ompBridgeToolName));

/**
 * Whether a Claude Code prompt goes to a person under `mode`.
 *
 * In Normal the CLI runs in `acceptEdits`, so an edit it still asks about
 * is one outside the workspace -- risky by definition, and asked.
 *
 * An OMP bridge tool runs a model and tools of its own, billed to the
 * OpenRouter key, so it is not "other" and allowed: under Normal only the
 * read-only ones run unasked (Claude Code is started with them allowed,
 * so it does not ask about those at all); under Strict every one asks.
 */
export function claudePromptNeedsPerson(mode: AgentPermissionMode, toolName: string, input: unknown): boolean {
  if (toolName.startsWith(ompBridgeToolName(""))) {
    return mode === "allow_all" ? false : !(mode === "normal" && OMP_BRIDGE_READS.has(toolName));
  }
  if (CLAUDE_EDIT_TOOLS.has(toolName)) return mode !== "allow_all";
  const kind = toolName === "Bash" ? "exec" : "other";
  return needsApproval(mode, { kind, command: shellCommandOf(input) });
}

/**
 * Whether an OMP approval goes to a person under `mode`.
 *
 * OMP runs under the approval mode `mode` maps to (`approvalFor`), so it
 * only asks about what that mode holds back: under Strict, every write and
 * command, all of which a person answers. Under Normal it asks about every
 * `bash` call, where UCCH's Normal asks only about risky ones -- so the rest
 * are allowed here, as Claude Code's are. Its other commands (`eval`,
 * `task`, a host tool's device call) run code the harness cannot read the
 * risk of, and go to the person. After "Allow All", nothing does.
 */
function ompPromptNeedsPerson(mode: AgentPermissionMode, toolName: string, input: unknown): boolean {
  if (mode === "allow_all") return false;
  if (mode === "normal" && toolName === "bash") {
    const command = shellCommandOf(input);
    return command === null || isRiskyCommand(command);
  }
  return true;
}

/** How an OMP turn reaches UCCH's own tools: they are host tools, mounted as devices. */
const OMP_HOST_TOOLS_NOTE =
  "UCCH's own tools named below are xd:// devices: call one by writing its JSON arguments to xd://<name> " +
  "with your write tool, e.g. xd://current_time.";

/**
 * A research turn on OMP (solution §3.7): the native loop's pipeline, in
 * the same order and for the same reasons (`RESEARCH_RULES` in
 * `@ucch/agent`), with the two differences OMP makes -- the tools are
 * devices, and the preset's overlay denies every file change.
 */
const OMP_RESEARCH_RULES = `## Research turn

This is a research turn. The developer wants live, sourced information, not code changes, and this turn cannot change any file. ${OMP_HOST_TOOLS_NOTE} The pipeline's order is deliberate:

1. research_search first: a live web search that returns an answer, the URLs it drew on, and a line on each. Run several focused queries rather than one broad one -- one per sub-question, one per claim you need to check.
2. research_read next, on the URLs that matter: a fast crawler, fine to call on several URLs in parallel. Read the page before you state anything from it as fact; a search summary is a lead, not a source. A gated page is escalated to the browser agent on its own.
3. research_browse only for a page that needs interaction -- something to click, a search form, pagination. It drives a real browser and takes minutes; say precisely what to do and what to bring back.

Then write the answer. Cite the URL beside every claim it supports. Keep what the sources confirm separate from what you inferred, and say what you could not find rather than filling it in. Give dates as the sources give them, and call current_time before saying how recent anything is. The answer is the deliverable: if asked to save the findings, say that this turn cannot write files.`;

/**
 * A documentation turn on OMP: the native loop's rules, whose tools OMP is
 * given as host tools, and what is different here.
 */
const OMP_DOCUMENTATION_RULES = `## Documentation turn

${OMP_HOST_TOOLS_NOTE} The rules below were written for a harness with no shell: you have one, but use the document tools for anything a document needs. Where they say write_file, use your own write tool. Every file you write or edit must be under docs/: anything else is refused.

${DOCUMENTATION_RULES}`;

/**
 * What an OMP turn adds to OMP's system prompt (solution §3.8): the
 * project's `.ucch/` knowledge, then the few rules that are UCCH's rather
 * than the project's, then the composer mode's. OMP reads the worktree's
 * AGENTS.md itself.
 */
export function ompInstructions(workspace: string, knowledge: string | null, mode?: MessageMode): string {
  const rules = [
    "## Working in UCCH",
    "",
    `You are working in ${workspace}, a checkout UCCH manages. Keep your changes inside it.`,
    "- Ask any question in your reply: the chat is where the person reads and answers it.",
    "- Never commit or push. The person reviews and commits your changes from UCCH's Git view.",
  ].join("\n");
  const modeRules = mode === "research" ? OMP_RESEARCH_RULES : mode === "documentation" ? OMP_DOCUMENTATION_RULES : null;
  const parts = [knowledge?.trimEnd(), rules, modeRules].filter((part): part is string => Boolean(part));
  return `${parts.join("\n\n")}\n`;
}

/** The shell line a call runs, when it is one: `bash`'s and `Bash`'s `command`. */
function shellCommandOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}
