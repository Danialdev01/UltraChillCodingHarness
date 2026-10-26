import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import { projects, threads, turns, users, workspaces, type Database } from "@ucch/db";
import {
  HostExecutor,
  invalidateTree,
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
  needsApproval,
  type Command,
  type DomainEvent,
  type MessageMode,
  type ProviderId,
  type ReasoningEffort,
  type TokenUsage,
} from "@ucch/protocol";
import type { AgentRun } from "@ucch/providers";
import { detectStack } from "./clone.js";
import { decryptSecret } from "./crypto.js";
import { ensureProjectInfo, readProjectKnowledge } from "./dev-database.js";
import { workspaceSubject, type ProviderService } from "./providers.js";
import { toPolicy } from "./workspaces.js";
import { applyProjection } from "./engine.js";
import { treeFor, worktreeIdOf } from "./trees.js";
import type { EventStore } from "./eventstore.js";
import { contextLengthFor, streamCompletion, supportsImages } from "./openrouter.js";
import { documentationPrompt } from "./documents.js";
import { briefedPrompt, EMPTY_BRIEF, researchAsk } from "./research.js";
import { DeltaCoalescer, isDelta } from "./delta-coalescer.js";
import { TurnScheduler } from "./turn-scheduler.js";

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

/**
 * Which backend a turn runs on.
 *
 * A bound thread wins over everything: its CLI session cannot move. Then
 * what the turn asked for, then the account's default, then the native loop.
 * `decide()` has already refused a request that disagrees with the binding,
 * so the first two never conflict by the time this runs.
 */
export function resolveProvider(
  requested: ProviderId | undefined,
  threadBound: string | null,
  accountDefault: string | null,
): ProviderId {
  const known = (value: string | null | undefined): ProviderId | null =>
    value === "native" || value === "claude" || value === "codex" ? value : null;
  return known(threadBound) ?? known(requested) ?? known(accountDefault) ?? "native";
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

  /** Starts a turn for each user message, and stops one on a cancel. */
  react(command: Command, batch: readonly DomainEvent[]): void {
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
      if (event.type !== "user.message") continue;
      // The model and effort ride on the command rather than the event: they
      // are how this turn was asked for, not something that happened.
      const sent = command.type === "thread.send" ? command : undefined;
      void this.#run(event.threadId, event.text, {
        model: sent?.model,
        effort: sent?.effort,
        provider: sent?.provider,
        // From the event, not the command: it is recorded there, and a turn
        // replayed from the log runs the same pipeline the original did.
        mode: event.mode,
      }).catch(this.onError);
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
  async #run(threadId: string, text: string, options: TurnOptions): Promise<void> {
    const controller = new AbortController();
    this.#running.set(threadId, controller);
    try {
      await this.#turn(threadId, text, options, controller);
    } finally {
      // Only if it is still ours: a turn that overran its own cancellation
      // must not clear a controller the next turn has already registered.
      if (this.#running.get(threadId) === controller) this.#running.delete(threadId);
    }
  }

  async #turn(
    threadId: string,
    text: string,
    { model, effort, provider: requestedProvider, mode }: TurnOptions,
    controller: AbortController,
  ): Promise<void> {
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

    let project: { stack: string | null } | undefined;
    let owner: TurnOwner | null;
    try {
      [project] = await this.db
        .select({ stack: projects.stack })
        .from(projects)
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

    const write = (batch: readonly DomainEvent[]) => {
      if (batch.length === 0) return Promise.resolve([]);
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
      const provider = resolveProvider(requestedProvider, thread.provider, owner.defaultProvider);

      // A slot, before the turn opens: over the server's limits the turn
      // waits here, with no `turns` row and nothing billed, and the thread
      // hears how many are ahead of it. Stopped while it waits, it never
      // opens. Given back in `finally`, however the turn ends.
      try {
        release = await this.#scheduler.acquire({
          ownerId: owner.id,
          kind: provider === "native" ? "native" : "cli",
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
        await append([
          { type: "turn.started", threadId, turnId, provider, ...(model ? { model } : {}) },
        ]);

        // A research turn on a CLI is two phases under one turn id: the
        // pipeline runs first on OpenRouter -- the CLI has its own tools and
        // none of these -- and what it found is handed to the CLI with the
        // message. The phase's events land on the thread as they happen, so
        // the person watches the research before the CLI starts on it.
        let prompt = text;
        let researched: { usage: TokenUsage; costUsd: number } | undefined;
        if (mode === "research") {
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
        if (mode === "documentation") {
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
          model,
          effort,
          signal: controller.signal,
          append,
          ...(researched ? { researched } : {}),
        });
        return;
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
        executor: new HostExecutor(workspace),
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
   */
  async #runCli(
    provider: "claude" | "codex",
    input: {
      ownerId: string;
      owner: { agentPermissionMode: string | null };
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

    let run: AgentRun | undefined;
    try {
      await this.#prepareWorkspace(input.workspace);
      const knowledge = await readProjectKnowledge(input.workspace).catch((error: unknown) => {
        this.onError(error);
        return null;
      });
      // Logged as the native loop logs its prompt parts, so the thread says
      // exactly what the CLI was handed on top of the message.
      if (knowledge) {
        await input.append([
          { type: "context.injected", threadId: input.threadId, source: "project_context", content: knowledge },
        ]);
      }
      const resolved = await this.options.providers.resolve(input.ownerId, provider);
      run = resolved.provider.run({
        ctx: resolved.ctx(input.workspace),
        prompt: input.text,
        projectId: input.projectId,
        threadId: input.threadId,
        turnId: input.turnId,
        ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        permissionMode: this.#modeFor(input.threadId, input.owner),
        ...(knowledge ? { instructions: knowledge } : {}),
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
      try {
        for await (const event of run.events) {
          if (event.type === "agent.permission_requested") {
            const mode = this.#modeFor(input.threadId, input.owner);
            if (
              !claudePromptNeedsPerson(mode, event.toolName, event.input) &&
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
    } finally {
      if (run) {
        this.#cliRuns.delete(run);
        if (this.#cliByThread.get(input.threadId) === run) this.#cliByThread.delete(input.threadId);
      }
    }
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
      executor: new HostExecutor(input.workspace),
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
        executor: new HostExecutor(workspace),
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

/**
 * Whether a Claude Code prompt goes to a person under `mode`.
 *
 * In Normal the CLI runs in `acceptEdits`, so an edit it still asks about
 * is one outside the workspace -- risky by definition, and asked.
 */
function claudePromptNeedsPerson(mode: AgentPermissionMode, toolName: string, input: unknown): boolean {
  if (CLAUDE_EDIT_TOOLS.has(toolName)) return mode !== "allow_all";
  const kind = toolName === "Bash" ? "exec" : "other";
  return needsApproval(mode, { kind, command: shellCommandOf(input) });
}

/** The shell line a call runs, when it is one: `bash`'s and `Bash`'s `command`. */
function shellCommandOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}
