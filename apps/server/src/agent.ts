import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, threads, users, type Database } from "@ucch/db";
import {
  HostExecutor,
  invalidateTree,
  runTurn,
  type RegistryOptions,
  type ResearchBackends,
  type UploadStaging,
} from "@ucch/agent";
import {
  isTransient,
  type Command,
  type DomainEvent,
  type MessageMode,
  type ProviderId,
  type ReasoningEffort,
  type TokenUsage,
} from "@ucch/protocol";
import type { AgentRun } from "@ucch/providers";
import { decryptSecret } from "./crypto.js";
import type { ProviderService } from "./providers.js";
import { applyProjection } from "./engine.js";
import type { EventStore } from "./eventstore.js";
import { contextLengthFor, streamCompletion, supportsImages } from "./openrouter.js";
import { briefedPrompt, EMPTY_BRIEF, researchAsk } from "./research.js";

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
   * The CLI providers. Optional so a harness can run with the native loop
   * alone; a turn that asks for one then fails with a message saying so.
   */
  providers?: ProviderService;
  /** False refuses `claude` and `codex` outright: see `cliProvidersEnabled`. */
  cliEnabled?: boolean;
  /** CLI turns one account may have in flight. */
  maxConcurrentPerUser?: number;
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

  /** CLI turns in flight per owning account, for the concurrency cap. */
  readonly #perUser = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly store: EventStore,
    private readonly options: AgentOptions,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Starts a turn for each user message, and stops one on a cancel. */
  react(command: Command, batch: readonly DomainEvent[]): void {
    if (command.type === "thread.cancel") {
      // The loop notices between tool calls and unwinds itself; a tool
      // already dispatched still records its result rather than vanishing.
      this.#running.get(command.threadId)?.abort();
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

  /** Whether a turn is in flight. For tests and for shutdown. */
  get activeTurns(): number {
    return this.#running.size;
  }

  /** Hard-stops every CLI run: the teardown path, not the stop button. */
  async killAll(): Promise<void> {
    await Promise.all([...this.#cliRuns].map((run) => run.kill().catch(() => {})));
  }

  async #run(
    threadId: string,
    text: string,
    {
      model,
      effort,
      provider: requestedProvider,
      mode,
    }: {
      model?: string | undefined;
      effort?: ReasoningEffort | undefined;
      provider?: ProviderId | undefined;
      mode?: MessageMode | undefined;
    },
  ): Promise<void> {
    const [thread] = await this.db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
    if (!thread) return;

    const [project] = await this.db
      .select({ stack: projects.stack })
      .from(projects)
      .where(eq(projects.id, thread.projectId))
      .limit(1);
    if (!project) return;

    // The owning account, not whoever sent the message: the turn is paid for
    // and configured by the account that owns the work. Read once, before the
    // turn opens, because the model it may name is recorded in `turn.started`.
    const owner = await this.#owner(thread.projectId);
    if (!owner) return;

    const turnId = randomUUID();
    const target = { projectId: thread.projectId, threadId };

    const workspace = join(this.options.workspaceRoot, thread.projectId);

    const append = (events: readonly DomainEvent[]) => {
      if (events.length === 0) return Promise.resolve([]);
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

    const controller = new AbortController();
    this.#running.set(threadId, controller);

    try {
      // First, and before anything that can fail slowly: this is what
      // inserts the `turns` row and moves the thread to `running`, so until
      // it lands a cancel has nothing to find and no turn is recorded.
      // The model is resolved here rather than at the call to `runTurn`
      // below so the event that opens the turn records what it was actually
      // billed against -- the `turns` row is what the usage breakdown reads.
      //
      // Three steps, narrowest first: what this turn asked for, then the
      // account's default from Settings, then the server's. A message sent
      // from the composer always names one; the fallbacks are for everything
      // that does not -- another client, or a turn started by the harness.
      const provider = resolveProvider(requestedProvider, thread.provider, owner.defaultProvider);
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

        await this.#runCli(provider, {
          ownerId: owner.id,
          threadId,
          turnId,
          projectId: thread.projectId,
          workspace,
          text: prompt,
          resumeToken: thread.providerSessionId,
          model,
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
      await mkdir(workspace, { recursive: true });

      const history = await this.store.readThread(threadId);

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
        ...(effort ? { effort } : {}),
        history: history.map((row) => row.event),
        stack: project.stack,
        // The preset and the mode travel together: the research prompt
        // describes the research tools, and only that preset offers them.
        preset: mode === "research" ? "research" : "standard",
        ...(mode === "research" ? { mode, research: this.options.research } : {}),
        registry: this.options.registry,
        contextLength,
        supportsImages: canSeeImages,
        searchModel: this.options.searchModel,
        maxIterations: this.options.maxIterations,
        executor: new HostExecutor(workspace),
        ...(this.options.uploads ? { uploads: this.options.uploads } : {}),
        complete: streamCompletion,
        signal: controller.signal,
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
      // Only if it is still ours: a turn that overran its own cancellation
      // must not clear a controller the next turn has already registered.
      if (this.#running.get(threadId) === controller) this.#running.delete(threadId);
    }
  }

  /**
   * A turn under a vendor CLI.
   *
   * The provider spawns the process and hands back events already in the
   * harness's own vocabulary, so what remains here is what the native path
   * does around `runTurn`: the gate, the cap, the cancel hook, and writing
   * each event through the same `append` -- which is what keeps the file
   * tree cache and the projection honest for both.
   */
  async #runCli(
    provider: "claude" | "codex",
    input: {
      ownerId: string;
      threadId: string;
      turnId: string;
      projectId: string;
      workspace: string;
      text: string;
      resumeToken: string | null;
      model: string | undefined;
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

    // One subscription is one human; a few threads running at once on it is
    // how a rate limit gets mistaken for a broken integration.
    const cap = this.options.maxConcurrentPerUser ?? 2;
    const inFlight = this.#perUser.get(input.ownerId) ?? 0;
    if (inFlight >= cap) {
      throw new Error(
        `Too many agents are running on your account (limit ${cap}). Wait for one to finish, then send again.`,
      );
    }
    this.#perUser.set(input.ownerId, inFlight + 1);

    let run: AgentRun | undefined;
    try {
      await mkdir(input.workspace, { recursive: true });
      const resolved = await this.options.providers.resolve(input.ownerId, provider);
      run = resolved.provider.run({
        ctx: resolved.ctx(input.workspace),
        prompt: input.text,
        projectId: input.projectId,
        threadId: input.threadId,
        turnId: input.turnId,
        ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
        ...(input.model ? { model: input.model } : {}),
      });
      this.#cliRuns.add(run);

      // The stop button is SIGINT: the CLI ends the turn and records what
      // it managed. SIGTERM would strand the turn unfinished (see `killAll`).
      const current = run;
      const onAbort = () => void current.interrupt().catch(this.onError);
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();

      try {
        for await (const event of run.events) {
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
      }
    } finally {
      if (run) this.#cliRuns.delete(run);
      const left = (this.#perUser.get(input.ownerId) ?? 1) - 1;
      if (left <= 0) this.#perUser.delete(input.ownerId);
      else this.#perUser.set(input.ownerId, left);
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
    await mkdir(input.workspace, { recursive: true });

    // The thread's earlier asks, for a follow-up to follow on from. Only
    // what the person typed: the CLI's own events are not replayable here.
    const history = await this.store.readThread(input.threadId);
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
   * What the project's owning account brings to a turn: the key it is billed
   * to, and the model it prefers when the turn names none.
   *
   * One read for both, resolved through the project rather than through the
   * sender. Null only when the project has no row to join, which means it was
   * deleted between the message and this.
   */
  async #owner(projectId: string): Promise<{
    id: string;
    openrouterKeyEncrypted: string | null;
    defaultModel: string | null;
    defaultProvider: string | null;
  } | null> {
    const [owner] = await this.db
      .select({
        id: users.id,
        openrouterKeyEncrypted: users.openrouterKeyEncrypted,
        defaultModel: users.defaultModel,
        defaultProvider: users.defaultProvider,
      })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.userId))
      .where(eq(projects.id, projectId))
      .limit(1);
    return owner ?? null;
  }

  /** The stored key in the clear, for exactly this turn. */
  #decryptKey(encrypted: string | null): string {
    if (!this.options.secretKey) {
      throw new Error("SECRET_KEY is not configured, so no stored key can be decrypted");
    }
    if (!encrypted) {
      throw new Error("No OpenRouter API key is set. Add one in Settings to talk to the agent.");
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
