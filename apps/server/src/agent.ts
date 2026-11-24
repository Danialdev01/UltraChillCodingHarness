import { randomUUID } from "node:crypto";
import { contextAllowed, toRef, toView, type AgentProfiles } from "./agent-profiles.js";
import type { ProfileRef } from "./profile-ref.js";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { events, projects, threads, turns, users, workspaces, type AgentProfile, type Database } from "@ucch/db";
import {
  HostExecutor,
  hostToolSchemas,
  invalidateTree,
  type HeavyJobGate,
  runTool,
  runTurn,
  type ApprovalDecision,
  type ApprovalRequest,
  type Executor,
  type RegistryOptions,
  type DocumentsBackends,
  type ResearchBackends,
  type UploadStaging,
} from "@ucch/agent";
import {
  AgentPermissionMode,
  cliContextWindow,
  estimateTokens,
  handoffBudgetChars,
  handoffBudgetTokens,
  IDLE_COMPACT_LEAD_MS,
  idleCompactAt,
  idleCompactionSkip,
  offerCompactOnResume,
  overWindow,
  readingNeedsCompaction,
  type ContextReading,
  type SessionPrefix,
  DEFAULT_AGENT_PERMISSION_MODE,
  effectiveCredentialSource,
  isTransient,
  isRiskyCommand,
  isOpenRouterLimit,
  isUcchAgentTool,
  limitFallback,
  planDraftPrompt,
  planRunPrompt,
  proposedPlanIn,
  type PlanStage,
  UCCH_AGENT_ARGS,
  UCCH_AGENT_DESCRIPTION,
  UCCH_AGENT_GUIDE,
  UCCH_SUBAGENT_RULES,
  UCCH_AGENT_TOOL,
  SHOW_WIDGET_TOOL,
  WIDGET_TURN_NUDGE,
  asksForWidget,
  needsApproval,
  readAgentSettings,
  REMOTE_CHAT_PROJECT_ID,
  isModelImageType,
  parseAttachmentManifest,
  type CliProviderId,
  type Command,
  type DomainEvent,
  type MessageImage,
  type MessageMode,
  type MessageKnowledge,
  type ProviderId,
  type ReasoningEffort,
  type TokenUsage,
  type WorkspaceAgentSettings,
} from "@ucch/protocol";
import {
  OMP_BRIDGE_READ_TOOLS,
  ompBridgeToolName,
  type AgentRun,
  type HostToolCall,
  type HostToolResult,
  type OmpMaintenanceInput,
  type OmpProvider,
  type OmpRunFiles,
  type ProviderImage,
  type ProviderRunInput,
} from "@ucch/providers";
import { detectStack } from "./clone.js";
import { decryptSecret } from "./crypto.js";
import { ensureProjectInfo, readProjectKnowledge } from "./dev-database.js";
import { workspaceSubject, type ProviderService } from "./providers.js";
import { toPolicy } from "./workspaces.js";
import { applyProjection, readingOf } from "./engine.js";
import { treeFor, worktreeIdOf } from "./trees.js";
import { TurnSnapshots } from "./turn-snapshot.js";
import type { Principal } from "./auth.js";
import type { EngineResult } from "./engine.js";
import { cliTranscriptExists } from "./cli-session-files.js";
import { conversationRecap, exchangesOf } from "./thread-transcript.js";
import { buildHandoffBrief, handoffMessage, handoffPrompt, handoffTitle, renderTranscript, type BriefAsker } from "./omp-handoff.js";
import { messageText, RETAIN_PROMPT, retainStdin } from "./omp-memory.js";
import { runReview } from "./omp-review.js";
import { runGit } from "./git-exec.js";
import type { EventStore } from "./eventstore.js";
import { contextLengthFor, streamCompletion, supportsImages } from "./openrouter.js";
import { stagedImageDescriber } from "./describe-image.js";
import { documentationPrompt } from "./documents.js";
import type { KnowledgeService } from "./knowledge.js";
import { briefedPrompt, EMPTY_BRIEF, researchAsk } from "./research.js";
import { DeltaCoalescer, isDelta } from "./delta-coalescer.js";
import { TurnScheduler, type TurnKind } from "./turn-scheduler.js";
import { DEFAULT_OMP_SETTINGS, writeOmpOverlay, type OmpPreset } from "./omp-overlay.js";
import { bridgeServer, writeClaudeMcpConfig, writeCodexBridge } from "./omp-bridge-config.js";
import type { ArgvWrapper } from "./child-priority.js";
import { registry as metrics } from "./metrics.js";
import type { EventBus } from "./bus.js";
import { catalogue } from "./openrouter.js";
import { accountOpenRouterKey, anonCatalogue, baseUrlFor, parseKeyedModel, type ModelKeyStore } from "./model-keys.js";
import type { Complete } from "@ucch/agent";
import type { BrowserManager } from "@ucch/browser";
import { browserSpec, isBrowserOp, type BrowserProvider, type BrowserResult } from "@ucch/browser/tools";
import { ChoiceWaiters, accountBlocker, harnessAvailability, harnessLabel, limitOptions, type LimitAccount } from "./choices.js";
import { AgentMessaging, COLLABORATION_GUIDE } from "./agent-messaging.js";
import { assembleCliInstructions, planSessionPrefix } from "./cli-instructions.js";
export { ompInstructions } from "./cli-instructions.js";
import { SubagentRunner, type SubagentCall, type SubagentRequest } from "./subagents.js";
import type { OpenedMemory, SessionMemory } from "./session-memory.js";

export interface AgentOptions {
  secretKey: string | undefined;
  /**
   * How long before a Claude Code session's prompt cache runs out its idle
   * compaction starts (plan2 §3.3). `IDLE_COMPACT_LEAD_MS` when absent.
   */
  idleCompactLeadMs?: number;
  /**
   * A stored OpenRouter key was decrypted for a call: its ciphertext, for
   * the account's "last used" (`KeyUsage.touchCiphertext`). Never the key.
   */
  onKeyUsed?: (encrypted: string) => void;
  /**
   * The account's named model keys (OpenRouter, AnonRouter). A native turn
   * on a model id of the form `@<keyId>/<model>` bills that key instead of
   * the default one.
   */
  modelKeys?: ModelKeyStore;
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
   * The workspace's knowledge bases, for a message sent with some picked
   * (`thread.send`'s `knowledge`). Absent, such a message runs as usual.
   */
  knowledge?: KnowledgeService;
  /**
   * Where the native loop's document renders wait for one another: one gate
   * for the whole server, so `DOC_JOBS_MAX` holds across every turn.
   */
  heavyJobs?: HeavyJobGate;
  /** Puts the native loop's tool calls behind a lower priority (child-priority.ts). */
  wrapArgv?: ArgvWrapper;
  /**
   * The folder to put first on PATH for a command run in a workspace: that
   * project's runtime versions (runtimes/manager.ts `pathFor`).
   */
  runtimePath?: (cwd: string) => string | null;
  /**
   * The CLI providers. Optional so a harness can run with the native loop
   * alone; a turn that asks for one then fails with a message saying so.
   */
  providers?: ProviderService;
  /**
   * Named subscription accounts. Absent: every Claude Code and Codex turn
   * runs on the subject's Default account, as before profiles.
   */
  profiles?: AgentProfiles;
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
  /**
   * The bus, for following a subagent's session (`ucch_agent`). Without it
   * (and `dispatch`), no turn is offered subagents on other harnesses.
   */
  bus?: Pick<EventBus, "subscribe">;
  /**
   * Which sessions' memories a run recalls (`session-memory.ts`). Without
   * it every run reads and writes its project's one bank.
   */
  memory?: SessionMemory;
  /**
   * The agents' shared browser (`@ucch/browser`). Absent: no Chromium on
   * this server, or `BROWSER_ENABLED=false`; no turn gets browser tools.
   */
  browser?: BrowserManager;
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
  subagentId?: string;
  /** The handle a Claude Code subagent is continued by, from its own events. */
  subagentHandle?: string | undefined;
  model?: string | undefined;
  effort?: ReasoningEffort | undefined;
  provider?: ProviderId | undefined;
  mode?: MessageMode | undefined;
  /** Plan mode's stage (`plan-mode.ts`): a read-only draft, or running the approved plan. */
  plan?: PlanStage | undefined;
  /** The pictures this message shows the model (`thread.send`'s `images`). */
  images?: readonly MessageImage[] | undefined;
  /** The knowledge bases this message is answered from, and whether the web is allowed too. */
  knowledge?: MessageKnowledge | undefined;
}

/** The account a turn is billed to; see `#owner`. */
interface TurnOwner {
  id: string;
  /** The person behind the turn, even when `id` is the workspace's subject. */
  personId: string;
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

/** `ucch_agent` as an OMP host tool: the bridge's tool, described the same way. */
const UCCH_AGENT_HOST_TOOL = {
  name: UCCH_AGENT_TOOL,
  label: "Subagent (any harness)",
  description: UCCH_AGENT_DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: UCCH_AGENT_ARGS.description },
      task: { type: "string", description: UCCH_AGENT_ARGS.task },
      model: { type: "string", description: UCCH_AGENT_ARGS.model },
      background: { type: "boolean", description: UCCH_AGENT_ARGS.background },
    },
    required: ["description", "task"],
    additionalProperties: false,
  },
};

const EFFORTS: ReadonlySet<string> = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function isEffort(value: string): value is ReasoningEffort {
  return EFFORTS.has(value);
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
   * Idle compactions armed, per thread (plan2 §3.3). The due time itself is
   * `threads.idle_compact_at`, so a restart re-arms them
   * (`rearmIdleCompactions`); this is only the timer.
   */
  readonly #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  /** Choice cards a subagent is waiting on (`SubagentRunner`). */
  readonly #choices = new ChoiceWaiters();

  /** `ucch_agent` subagents: absent without a bus and a dispatcher. */
  readonly #subagents: SubagentRunner | null;
  readonly messaging: AgentMessaging | null;
  #ompProbe: { at: number; value: Promise<boolean> } | null = null;

  readonly #snapshots: TurnSnapshots;

  /**
   * Each running turn's `ucch_agent` calls not yet matched to the subagent
   * they started: a bridge call reaches the server without the CLI's tool
   * call id, so it is matched here by its task (`#claimCall`).
   */
  readonly #spawnCalls = new Map<string, { turnId: string; calls: { toolUseId: string; task: string | null }[] }>();

  constructor(
    private readonly db: Database,
    private readonly store: EventStore,
    private readonly options: AgentOptions,
    private readonly onError: (error: unknown) => void,
  ) {
    this.#snapshots = new TurnSnapshots(options.workspaceRoot);
    this.#scheduler =
      options.scheduler ?? new TurnScheduler({ cliPerUser: 2, cliTotal: Infinity, nativeTotal: Infinity });
    const { bus, dispatch } = options;
    this.messaging = dispatch ? new AgentMessaging(db, store, dispatch, onError) : null;
    this.#subagents =
      bus && dispatch
        ? new SubagentRunner({
            db,
            store,
            bus,
            dispatch,
            harnesses: (subject, model) => this.#routingHarnesses(subject, model),
            manage: (child) => this.messaging?.manage(child),
            release: (child) => this.messaging?.release(child),
            notify: async (parent, child, text) => { await this.messaging?.notify(parent, child, text); },
            catalogue: () => catalogue(),
            customProvider: this.#customProvider(),
            claimCall: (threadId, request) => this.#claimCall(threadId, request),
            choices: this.#choices,
            allowAllFor: (threadId) => this.allowAllFor(threadId),
            onError,
          })
        : null;
  }

  /** What runs OpenRouter models: OMP with `OMP_ENABLED`, else the native loop. */
  #customProvider(): "omp" | "native" {
    return this.options.ompEnabled && this.options.cliEnabled ? "omp" : "native";
  }

  /** The harnesses a subject could run a turn on now. */
  async #harnesses(subject: string) {
    const cards = await this.options.providers?.health(subject);
    if (!cards) {
      return [{ provider: "native" as const, label: "Custom (OpenRouter)", usable: true, blocker: null, custom: true }];
    }
    return harnessAvailability(cards, { cliEnabled: this.options.cliEnabled ?? false, ompEnabled: this.options.ompEnabled ?? false });
  }

  async #routingHarnesses(subject: string, model?: string) {
    const available = await this.#harnesses(subject);
    const cards = await this.options.providers?.health(subject);
    return Promise.all(available.map(async (h) => {
      if (h.custom) {
        if (h.provider !== "omp" || !h.usable) return { ...h, usable: false, blocker: h.blocker ?? "Enable OMP to run cross-harness OpenRouter agents" };
        if (!this.#ompProbe || Date.now() - this.#ompProbe.at >= 30_000) {
          this.#ompProbe = { at: Date.now(), value: (async () => {
            if (!this.options.providers?.provider("omp")) return false;
            const resolved = await this.options.providers.resolve(subject, "omp");
            return (await resolved.provider.probe(resolved.ctx(this.options.workspaceRoot))).installed;
          })().catch(() => false) };
        }
        const installed = await this.#ompProbe.value;
        return { ...h, usable: installed, blocker: installed ? null : "OMP is not installed on this server" };
      }
      const provider = h.provider as "claude" | "codex";
      const quota = await this.options.providers?.quotas.get(subject, provider);
      const windows = quota?.status === "ok" ? quota.windows.filter((w) => !w.model || model?.toLowerCase().includes(w.model)) : [];
      return { ...h, usable: h.usable && cards?.[provider].authMode !== "api-key",
        quota: { status: quota?.status ?? "unavailable", ...(quota?.status === "ok" ? { checkedAt: quota.checkedAt } : {}), ...(windows.length ? { usedPercent: Math.max(...windows.map((w) => w.usedPercent)) } : {}) },
        ...(windows.length ? { usedPercent: Math.max(...windows.map((w) => w.usedPercent)) } : {}),
        ...(cards?.[provider].modelsAuthoritative ? { models: cards[provider].models } : {}) };
    }));
  }

  /** The shared browser is on for a workspace: the server has one, and the workspace has not turned it off. */
  #browserOn(settings: WorkspaceAgentSettings | undefined | null): boolean {
    return Boolean(this.options.browser) && settings?.browser?.enabled !== false;
  }

  /** Threads known to have used the browser: they are offered every browser tool from the start of a turn. */
  readonly #browserUsed = new Set<string>();

  /**
   * Which browser tools a turn is offered. A thread that has never used the
   * browser gets `browser_open` alone, whose description says when a browser
   * is worth it; opening one unlocks the rest (the native loop and the
   * bridge do that mid-turn). A thread that has used it gets them all.
   * `history` is the thread's events when the caller has them in hand.
   */
  async #browserToolset(settings: WorkspaceAgentSettings | undefined | null, threadId: string, history?: readonly { event: DomainEvent }[]): Promise<false | "entry" | "full"> {
    if (!this.#browserOn(settings)) return false;
    if (this.#browserUsed.has(threadId)) return "full";
    const used = history
      ? history.some(({ event }) => event.type === "agent.tool_use" && /browser_/.test(event.name))
      : (
          await this.db
            .select({ id: events.id })
            .from(events)
            .where(and(eq(events.threadId, threadId), eq(events.type, "agent.tool_use"), sql`${events.payload}->>'name' like '%browser\_%'`))
            .limit(1)
        ).length > 0;
    if (!used) return "entry";
    this.#browserUsed.add(threadId);
    return "full";
  }

  /** The browser bound to one agent session: its private session, its worktree for files. */
  #browserFor(projectId: string, threadId: string, worktree: string): BrowserProvider | undefined {
    const browser = this.options.browser;
    if (!browser) return undefined;
    const scope = { projectId, agentId: threadId, worktree };
    return { call: (op, args, signal) => browser.call(scope, op, args, signal) };
  }

  /**
   * A Claude Code or Codex turn's browser call, from its bridge over the
   * scheduler socket. The token already says the turn is live and was
   * offered the browser; the session's worktree is where its files go.
   */
  async browserCall(holder: { threadId: string }, op: string, args: unknown, signal: AbortSignal): Promise<BrowserResult> {
    const browser = this.options.browser;
    if (!browser) return { text: "The browser is not available on this server.", isError: true };
    this.#browserUsed.add(holder.threadId);
    if (!isBrowserOp(op)) return { text: `There is no browser tool called ${JSON.stringify(op)}.`, isError: true };
    const [thread] = await this.db.select().from(threads).where(eq(threads.id, holder.threadId)).limit(1);
    if (!thread) return { text: "The session is gone.", isError: true };
    const worktree = treeFor(this.options.workspaceRoot, thread.projectId, thread);
    return browser.call({ projectId: thread.projectId, agentId: thread.id, worktree }, op, args, signal);
  }

  async collaboration(holder: { threadId: string }, name: string, args: Record<string, unknown>) {
    if (!this.messaging) return { error: "project messaging is unavailable" };
    return this.messaging.call(holder.threadId, name, args);
  }

  async #coordinate(name: string, args: Record<string, unknown>, context: { threadId: string; turnId: string; toolUseId: string; signal: AbortSignal }) {
    if (name === UCCH_AGENT_TOOL) {
      const [thread] = await this.db.select().from(threads).where(eq(threads.id, context.threadId)).limit(1);
      const owner = thread ? await this.#owner(thread.projectId, thread) : null;
      if (!owner) return { content: "session not found", isError: true };
      return this.#hostSubagent({ id: context.toolUseId, toolCallId: context.toolUseId, toolName: name, arguments: args }, context.signal,
        { ownerId: owner.id, threadId: context.threadId, turnId: context.turnId });
    }
    const outcome = await this.collaboration(context, name, args);
    return "error" in outcome ? { content: outcome.error, isError: true } : { content: outcome.text, isError: false };
  }

  /**
   * A bridge's `ucch_agent` call, matched to the tool call it came from in
   * its turn's stream: by its task, else the oldest unmatched. The CLI may
   * run the tool a moment before its stream line reaches the server, so
   * this waits a little for one to arrive.
   */
  async #claimCall(threadId: string, request: SubagentRequest): Promise<SubagentCall | null> {
    for (let waited = 0; ; waited += 100) {
      const entry = this.#spawnCalls.get(threadId);
      if (!entry) return null;
      const at = entry.calls.findIndex((call) => call.task === request.task);
      const index = at >= 0 ? at : entry.calls.length > 0 ? 0 : -1;
      if (index >= 0) {
        const [call] = entry.calls.splice(index, 1);
        return { turnId: entry.turnId, toolUseId: call!.toolUseId };
      }
      if (waited >= 3_000) return { turnId: entry.turnId, toolUseId: null };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * One `ucch_agent` subagent a Claude Code or Codex turn's bridge asked
   * for over the scheduler socket (`BridgeLeases.setSpawner`). `holder` is
   * the turn's lease: whose subscriptions pay, and the parent session.
   */
  spawnSubagent(
    holder: { ownerId: string; threadId: string },
    request: SubagentRequest,
    signal: AbortSignal,
  ): Promise<{ text: string } | { error: string }> {
    if (!this.#subagents) return Promise.resolve({ error: "this server does not run subagents" });
    return this.#subagents.spawn(holder.threadId, holder.ownerId, request, signal);
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
      this.messaging?.pause(command.threadId);
      this.#subagents?.cancel(command.threadId);
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

    if (command.type === "thread.choice_reply") {
      const answer = {
        optionId: command.optionId === "dismiss" ? null : command.optionId,
        ...(command.model ? { model: command.model } : {}),
      };
      // A subagent waiting in this process takes it; otherwise it is a
      // card of the thread's own, read back from its log.
      if (this.#choices.answer(command.requestId, answer)) return;
      void this.#answerLimitCard(command.threadId, command.requestId, answer, principal).catch(this.onError);
      return;
    }

    for (const event of batch) {
      if (event.type === "thread.harness_switch_requested") {
        void this.#switchHarness(event, principal).catch(this.onError);
        continue;
      }
      if (event.type === "thread.compaction_requested") {
        void this.#compact(event.threadId, event.method, event.focus, { auto: event.auto === true, idle: event.idle === true }).catch(this.onError);
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
      if (!sent?.agentMessageIds) this.messaging?.resume(event.threadId);
      void this.#run(
        event.threadId,
        event.text,
        {
          subagentId: event.subagentId,
          subagentHandle: event.subagentHandle,
          model: sent?.model,
          effort: sent?.effort,
          provider: sent?.provider,
          // From the event, not the command: it is recorded there, and a turn
          // replayed from the log runs the same pipeline the original did.
          mode: event.mode,
          plan: event.plan,
          images: event.images,
          knowledge: sent?.knowledge,
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
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
    this.messaging?.shutdown();
    this.#subagents?.shutdown();
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
      if (!controller.signal.aborted) setImmediate(() => void this.messaging?.deliver(threadId).catch(this.onError));
    }
    // After the turn has let go of the thread: the handoff claims it anew.
    if (limited) await this.#handOffOnLimit(threadId, limited, text, principal);
    else if (!controller.signal.aborted) {
      const compacting = await this.#handOverIfFull(threadId, principal).catch((error: unknown) => {
        this.onError(error);
        return false;
      });
      if (!compacting) await this.#scheduleIdleCompaction(threadId).catch(this.onError);
    }
  }

  /**
   * A plan-mode turn's prompt (`plan-mode.ts`): a draft's rules ahead of the
   * message, or the thread's newest proposed plan ahead of a run's. A run
   * with no plan to find is sent as it is.
   */
  async #planPrompt(threadId: string, plan: PlanStage, text: string): Promise<string> {
    if (plan === "draft") return planDraftPrompt(text);
    const found = latestProposedPlan((await this.store.threadHistory(threadId)).map((row) => row.event));
    return found ? planRunPrompt(found, text) : text;
  }

  /**
   * A session that ended its turn past the server's line
   * (`CONTEXT_FORCE_RATIO`) is compacted in its own session before the next
   * message (plan2 §3.2): `thread.handoff { auto }`, which `decide` turns
   * into a compaction for Claude Code, Codex and OMP -- the CLI's own
   * `/compact`, Codex's app server, OMP's command. Quiet (`auto`): a divider
   * in the chat and nothing else. A handover to a new session is only the
   * fallback, when the compaction fails (`#compact`).
   *
   * The reading is the thread's own (`threads.context_reading`), so a
   * restart between a turn and this check loses nothing; an unavailable one
   * triggers nothing.
   *
   * Each harness also keeps under its own line mid-turn, so long work runs
   * on: Claude Code and Codex by their auto-compaction at their defaults,
   * OMP by its overlay's threshold, the native loop by its compactor (which
   * is why native threads are left alone here).
   *
   * A thread sent another message meanwhile refuses it (busy): the turn
   * after that one tries again. True when a compaction was asked for.
   */
  async #handOverIfFull(threadId: string, principal: Principal | undefined): Promise<boolean> {
    const dispatch = this.options.dispatch;
    if (!dispatch) return false;
    const [thread] = await this.db
      .select({
        provider: threads.provider,
        parentThreadId: threads.parentThreadId,
        contextReading: threads.contextReading,
        projectId: threads.projectId,
        createdByUserId: threads.createdByUserId,
      })
      .from(threads)
      .where(eq(threads.id, threadId))
      .limit(1);
    if (!thread || thread.parentThreadId) return false;
    if (thread.provider !== "claude" && thread.provider !== "codex" && thread.provider !== "omp") return false;
    if (!readingNeedsCompaction(thread.contextReading)) return false;
    const by = principal ?? (await this.#internalPrincipal(thread));
    if (!by) return false;
    const result = await dispatch(by, { type: "thread.handoff", threadId, auto: true });
    if (!result.ok) this.onError(new Error(`automatic compaction of ${threadId} refused: ${result.message}`));
    return result.ok;
  }

  /**
   * The server acting on a thread by itself -- an idle compaction, the
   * handover after a failed one -- as the person it bills: the thread's
   * creator, or the project's owner. Marked internal, which is what lets
   * `decide` take the commands only the server may send.
   */
  async #internalPrincipal(thread: { projectId: string; createdByUserId: string | null }): Promise<Principal | null> {
    let userId = thread.createdByUserId;
    if (!userId) {
      const [project] = await this.db.select({ userId: projects.userId }).from(projects).where(eq(projects.id, thread.projectId)).limit(1);
      userId = project?.userId ?? null;
    }
    return userId ? { userId, sessionId: "agent-context", scopes: ["exec"], internal: true } : null;
  }

  /**
   * After a Claude Code turn: when its session is big enough to be worth
   * folding and its prompt cache's expiry is known, a `/compact` is armed
   * for just before the cache runs out (plan2 §3.3, after t3code's
   * `idleCompactionWindow`), so the compaction reads the history from the
   * cache rather than paying for it again -- and the person's next message
   * starts on the summary, not on a cold full history. The due time is kept
   * with the thread (`threads.idle_compact_at`); a new turn clears it.
   */
  async #scheduleIdleCompaction(threadId: string): Promise<void> {
    const [row] = await this.db
      .select({
        provider: threads.provider,
        parentThreadId: threads.parentThreadId,
        contextReading: threads.contextReading,
        agent: workspaces.agentSettings,
      })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(threads.id, threadId))
      .limit(1);
    if (!row || row.parentThreadId || row.provider !== "claude") return;
    if (!readAgentSettings(row.agent).idleCompaction.enabled) return;
    const at = idleCompactAt(row.contextReading, Date.now(), this.#idleLead());
    if (at === null) return;
    await this.db.update(threads).set({ idleCompactAt: new Date(at) }).where(eq(threads.id, threadId));
    this.#armIdle(threadId, at);
  }

  #idleLead(): number {
    return this.options.idleCompactLeadMs ?? IDLE_COMPACT_LEAD_MS;
  }

  #armIdle(threadId: string, at: number): void {
    this.#clearIdle(threadId);
    const timer = setTimeout(() => {
      this.#idleTimers.delete(threadId);
      void this.#idleCompactDue(threadId, at).catch(this.onError);
    }, Math.max(0, at - Date.now()));
    timer.unref?.();
    this.#idleTimers.set(threadId, timer);
  }

  #clearIdle(threadId: string): void {
    const timer = this.#idleTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.#idleTimers.delete(threadId);
  }

  /**
   * Arms again every idle compaction a restart dropped: the due times kept
   * with the threads. One whose cache has run out meanwhile is cleared --
   * it would read nothing from the cache any more.
   */
  async rearmIdleCompactions(): Promise<number> {
    const rows = await this.db
      .select({ id: threads.id, at: threads.idleCompactAt })
      .from(threads)
      .where(isNotNull(threads.idleCompactAt));
    let armed = 0;
    for (const row of rows) {
      const at = row.at?.getTime();
      if (at === undefined) continue;
      if (at + this.#idleLead() <= Date.now()) {
        await this.db.update(threads).set({ idleCompactAt: null }).where(eq(threads.id, row.id));
        continue;
      }
      this.#armIdle(row.id, at);
      armed++;
    }
    return armed;
  }

  /**
   * An idle compaction's moment: the skip rules (`idleCompactionSkip`),
   * then `thread.compact { idle }` as the server. Whatever happens the due
   * time is spent, unless a newer one replaced it.
   */
  async #idleCompactDue(threadId: string, at: number): Promise<void> {
    const [row] = await this.db
      .select({
        status: threads.status,
        archivedAt: threads.archivedAt,
        provider: threads.provider,
        providerSessionId: threads.providerSessionId,
        contextReading: threads.contextReading,
        idleCompactAt: threads.idleCompactAt,
        projectId: threads.projectId,
        createdByUserId: threads.createdByUserId,
        agent: workspaces.agentSettings,
      })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(threads.id, threadId))
      .limit(1);
    if (!row) return;
    const newerTurn = row.idleCompactAt?.getTime() !== at;
    if (newerTurn) return;
    await this.db.update(threads).set({ idleCompactAt: null }).where(eq(threads.id, threadId));
    const history = (await this.store.threadHistory(threadId)).map((stored) => stored.event);
    const [running] = await this.db
      .select({ n: count() })
      .from(threads)
      .where(and(eq(threads.parentThreadId, threadId), inArray(threads.status, ["queued", "running", "cancelling"])));
    const skip = idleCompactionSkip({
      enabled: readAgentSettings(row.agent).idleCompaction.enabled,
      status: row.status,
      archived: row.archivedAt !== null,
      pendingRequests: openRequests(history),
      backgroundWork: (running?.n ?? 0) > 0 || this.#running.has(threadId),
      lastWasCompaction: lastWasCompaction(history),
      harnessChanged: row.provider !== "claude" || row.contextReading?.harness !== row.provider || !row.providerSessionId,
      newerTurn,
    });
    if (skip) return;
    const dispatch = this.options.dispatch;
    const principal = await this.#internalPrincipal(row);
    if (!dispatch || !principal) return;
    const result = await dispatch(principal, { type: "thread.compact", threadId, idle: true });
    if (!result.ok) this.onError(new Error(`idle compaction of ${threadId} refused: ${result.message}`));
  }
  /**
   * A turn stopped on a usage limit (solution §5.4, OM4.6): a Claude Code or
   * Codex plan's, or the OpenRouter key's. The session carries on, in the
   * same thread, on another harness (`thread.switch_harness`), which is
   * asked the message that failed:
   *
   * - on the workspace's fallback, without asking, when it turns automatic
   *   handoff on (`agent_settings.autoHandoff`) -- once per chain, so a
   *   fallback limited too does not switch back on its own;
   * - otherwise on whichever the person picks from a card in the chat
   *   (`agent.choice_requested`, answered in `#answerLimitCard`).
   *
   * A subagent's session asks its parent instead (`SubagentRunner`).
   */
  async #handOffOnLimit(threadId: string, provider: ProviderId, text: string, principal: Principal | undefined): Promise<void> {
    const dispatch = this.options.dispatch;
    if (!dispatch || !principal) return;
    const [row] = await this.db
      .select({
        agent: workspaces.agentSettings,
        projectId: threads.projectId,
        parentThreadId: threads.parentThreadId,
        createdByUserId: threads.createdByUserId,
        credentialSource: threads.credentialSource,
      })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(threads.id, threadId))
      .limit(1);
    if (!row || row.parentThreadId) return;
    const history = await this.store.threadHistory(threadId);
    const target = limitFallback(readAgentSettings(row.agent), provider);
    const bounced = history.some(
      ({ event }) =>
        (event.type === "thread.handed_off" && event.reason === "limit") ||
        (event.type === "thread.harness_switched" && event.reason === "limit" && event.toProvider === provider),
    );
    if (target && !bounced) {
      const result = await dispatch(principal, {
        type: "thread.switch_harness",
        threadId,
        targetProvider: target,
        message: text,
        reason: "limit",
        // The server's own pick: refused if it would stay on the provider.
        auto: true,
      });
      if (result.ok) return;
      // Refused -- the thread was sent another message meanwhile, or its
      // worktree is gone: the person is asked instead.
      this.onError(new Error(`automatic switch of ${threadId} refused: ${result.message}`));
    }
    if (!row.projectId) return;
    const owner = await this.#owner(row.projectId, {
      createdByUserId: row.createdByUserId ?? null,
      credentialSource: row.credentialSource ?? null,
    });
    if (!owner) return;
    const options = limitOptions(
      await this.#harnesses(owner.id),
      provider,
      await this.#otherAccounts(row.projectId, owner, threadId, provider).catch((error: unknown) => {
        this.onError(error);
        return [];
      }),
    );
    const events: DomainEvent[] = [
      {
        type: "agent.choice_requested",
        threadId,
        requestId: randomUUID(),
        kind: "harness_limit",
        title: `${harnessLabel(provider)} hit its usage limit`,
        detail: "Carry this session on with another harness. The work so far goes over as a brief, and your last message is sent again.",
        options,
        provider,
        message: text,
      },
    ];
    await this.store.append({ projectId: row.projectId, threadId }, events, (tx) => applyProjection(tx, events, null));
  }

  /**
   * The subject's other accounts of `provider`, for a limit card: every one
   * but the account the thread ran on, with why it cannot be picked when
   * it cannot. Whether it is signed in is the CLI's own status check.
   */
  async #otherAccounts(projectId: string, owner: TurnOwner, threadId: string, provider: ProviderId): Promise<LimitAccount[]> {
    const profiles = this.options.profiles;
    const providers = this.options.providers;
    if (!profiles || !providers || (provider !== "claude" && provider !== "codex")) return [];
    const [thread] = await this.db.select({ profileId: threads.profileId }).from(threads).where(eq(threads.id, threadId)).limit(1);
    const current = await this.#profileFor(projectId, owner, thread?.profileId, provider).catch(() => null);
    const [project] = await this.db
      .select({ requiredContext: projects.requiredContext })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const rows = (await profiles.list(owner.id, provider)).filter((row) => row.id !== current?.id);
    return Promise.all(
      rows.map(async (row) => {
        const card = await providers.profileHealth(owner.id, provider, toRef(row)).catch(() => null);
        const view = toView({ ...row, authStatus: card?.authenticated ? "signed_in" : "signed_out" });
        return { id: row.id, label: row.label, blocker: accountBlocker(view, project?.requiredContext) };
      }),
    );
  }

  /**
   * The person's answer to a thread's own limit card: the switch it picks,
   * with the message the limit stopped. A card a later turn or switch has
   * overtaken, or one answered already, is left as it is.
   */
  async #answerLimitCard(
    threadId: string,
    requestId: string,
    answer: { optionId: string | null; model?: string },
    principal: Principal | undefined,
  ): Promise<void> {
    const dispatch = this.options.dispatch;
    if (!dispatch || !principal) return;
    const history = await this.store.threadHistory(threadId);
    let request: Extract<DomainEvent, { type: "agent.choice_requested" }> | undefined;
    let projectId: string | undefined;
    for (const stored of history) {
      const { event } = stored;
      if (event.type === "agent.choice_requested" && event.requestId === requestId) {
        request = event;
        projectId = stored.projectId;
      } else if (
        request &&
        ((event.type === "agent.choice_resolved" && event.requestId === requestId) ||
          event.type === "turn.started" ||
          event.type === "thread.harness_switch_requested")
      ) {
        return;
      }
    }
    if (!request || !projectId || request.kind !== "harness_limit") return;
    const resolved: DomainEvent[] = [
      { type: "agent.choice_resolved", threadId, requestId, optionId: answer.optionId, ...(answer.model ? { model: answer.model } : {}) },
    ];
    await this.store.append({ projectId, threadId }, resolved, (tx) => applyProjection(tx, resolved, null));
    const option = answer.optionId ? request.options.find((candidate) => candidate.id === answer.optionId) : undefined;
    if (!option?.provider) return;
    const result = await dispatch(principal, {
      type: "thread.switch_harness",
      threadId,
      targetProvider: option.provider,
      ...((answer.model ?? option.model) ? { model: answer.model ?? option.model } : {}),
      ...(request.message ? { message: request.message } : {}),
      reason: "limit",
      ...(option.profileId ? { targetProfileId: option.profileId } : {}),
    });
    if (!result.ok) {
      const failed: DomainEvent[] = [{ type: "thread.harness_switch_failed", threadId, error: result.message.slice(0, 2_000) }];
      await this.store.append({ projectId, threadId }, failed, (tx) => applyProjection(tx, failed, null));
    }
  }

  async #turn(
    threadId: string,
    text: string,
    { model, effort, provider: requestedProvider, mode, plan, subagentId, subagentHandle, images, knowledge }: TurnOptions,
    controller: AbortController,
  ): Promise<ProviderId | undefined> {
    const [thread] = await this.db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
    // Nothing to release: the thread, and its status, went with it.
    if (!thread) return;
    // A message came first: an idle compaction armed for it is overtaken.
    this.#clearIdle(threadId);

    // Until `turn.started`, the thread is `queued` and refuses every other
    // message: each way out before it says so, or the thread stays stuck.
    const dequeue = (reason: "error" | "cancelled") => {
      const event: DomainEvent = { type: "turn.dequeued", threadId, reason };
      return this.store
        .append({ projectId: thread.projectId, threadId }, [event], (tx) => applyProjection(tx, [event], null))
        .then(() => {}, this.onError);
    };

    let project: { stack: string | null; agent?: unknown; ompTrusted?: boolean; workspaceId?: string } | undefined;
    let owner: TurnOwner | null;
    try {
      // With the workspace's agent settings, which an OMP turn's overlay
      // reads, and the project's trust, which decides its LSP and debugger.
      [project] = await this.db
        .select({ stack: projects.stack, agent: workspaces.agentSettings, ompTrusted: projects.ompTrusted, workspaceId: projects.workspaceId })
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
    // Where this turn's `ucch_agent` calls wait to be matched (`#claimCall`).
    const spawnCalls = { turnId, calls: [] as { toolUseId: string; task: string | null }[] };
    this.#spawnCalls.set(threadId, spawnCalls);

    // A project session works in its own worktree; every other thread in
    // the project's checkout.
    const workspace = treeFor(this.options.workspaceRoot, thread.projectId, thread);
    // Its writes name the worktree, so a view of another tree skips them.
    const worktreeId = worktreeIdOf(this.options.workspaceRoot, { projectId: thread.projectId, tree: workspace });

    // The turn failed on its plan's usage limit (OM4.6): `#run` may hand it off.
    let limited = false;
    // The subscription account a CLI turn runs on, once it is known, and
    // when the CLI last said its limit resets.
    let profile: ProfileRef | null = null;
    let limitResetsAt: string | null = null;
    // Who runs it, once resolved below: the subagent count's label.
    let runsOn: ProviderId = "native";
    // The turn's latest context reading, kept with the thread when the turn
    // ends (plan2 §1.4): `context.usage` is never stored as an event, and
    // one write per model call would be one per streamed call.
    let reading: Extract<DomainEvent, { type: "context.usage" }> | null = null;
    const write = (batch: readonly DomainEvent[]) => {
      if (batch.length === 0) return Promise.resolve([]);
      if (batch.some((event) => event.type === "agent.turn_failed" && event.limit)) {
        limited = true;
        if (profile && this.options.profiles) {
          const at = limitResetsAt ? new Date(limitResetsAt) : null;
          void this.options.profiles.markLimited(profile.id, at && !Number.isNaN(at.getTime()) ? at : null).catch(this.onError);
        }
      }
      for (const event of batch) {
        if (event.type === "context.usage") reading = event;
        if (event.type === "agent.subagent_finished") subagentsTotal.inc({ provider: runsOn, status: event.status });
        // The CLI's own usage reading: the meters' only source for Claude.
        if (event.type === "agent.rate_limit" && owner) {
          if (event.resetsAt) limitResetsAt = event.resetsAt;
          if (event.provider === "claude") this.options.providers?.quotas?.record(owner.id, event.windows, profile);
        }
        if (event.type === "agent.tool_use" && isUcchAgentTool(event.name)) {
          const task = (event.input as { task?: unknown } | null)?.task;
          spawnCalls.calls.push({ toolUseId: event.toolUseId, task: typeof task === "string" ? task : null });
        }
      }
      const diff = batch.some((event) => event.type === "agent.turn_completed" || event.type === "agent.turn_failed")
        ? turnDiff()
        : null;
      return diff ? diff.then((found) => store([...found, ...batch])) : store(batch);
    };
    // The tree as the turn found it, until its end has been compared with it.
    let snapshot: string | null = null;
    const turnDiff = (): Promise<DomainEvent[]> | null => {
      const before = snapshot;
      snapshot = null;
      if (before === null) return null;
      return this.#snapshots.changes(thread.projectId, workspace, before).then(
        ({ files, omitted }) =>
          files.length > 0
            ? [{ type: "agent.turn_diff", threadId, turnId, files, shared: !worktreeId, omittedFiles: omitted }]
            : [],
        (error: unknown) => {
          // Never the turn's failure: there is only nothing to show.
          this.onError(error);
          return [];
        },
      );
    };
    const store = (batch: readonly DomainEvent[]) => {
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
      // The turn's end carries its last reading into the projection, which
      // keeps it with the thread; the event itself went out when it came.
      const ends = events.some((event) => event.type === "agent.turn_completed" || event.type === "agent.turn_failed");
      const projected = ends && reading ? [reading, ...events] : events;
      if (ends) reading = null;
      return this.store.append(
        target,
        events,
        durable ? (tx) => applyProjection(tx, projected, null) : undefined,
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
          // A subagent's turn counts in a per-account allowance of its own:
          // its parent holds one of the account's CLI slots while it waits,
          // and two subagents asked for at once should run at once. The
          // server's totals still hold over both.
          ownerId: thread.parentThreadId ? `${owner.id}:subagents` : owner.id,
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

      // Every attachment, and the text read out of it, into the tree this
      // turn works in, before any harness starts: the message names those
      // paths, and each harness reads them with its own tools.
      const pictures = await this.#placeAttachments(thread.projectId, workspace, text, images).catch((error: unknown) => {
        this.onError(error);
        return [] as ProviderImage[];
      });

      snapshot = await this.#snapshots.capture(thread.projectId, workspace).catch((error: unknown) => {
        this.onError(error);
        return null;
      });

      // The knowledge bases picked for this message: the folders their text
      // is kept in (read where they are, never copied into the tree), and the
      // passages and graph facts the message matches, into the prompt.
      // Only the thread's own workspace's bases count; a failure to search
      // is the operator's to hear about, and the turn runs without them.
      const turnKnowledge =
        knowledge && this.options.knowledge && project.workspaceId
          ? await this.options.knowledge.forTurn(project.workspaceId, knowledge, text, workspace).catch((error: unknown) => {
              this.onError(error);
              return null;
            })
          : null;
      const noWeb = turnKnowledge?.scope === "knowledge";
      if (turnKnowledge) {
        await append([{ type: "context.injected", threadId, source: "knowledge", content: turnKnowledge.prompt }]);
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
        // After the turn opens, so an account the project refuses shows as
        // this turn's failure, in the conversation.
        const account = await this.#profileFor(thread.projectId, owner, thread.profileId, provider);
        profile = account ? toRef(account) : null;
        if (account) void this.options.profiles?.touch(account.id).catch(this.onError);

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

        if (turnKnowledge) prompt = `${turnKnowledge.prompt}\n\n${prompt}`;

        // A message asking for a visual is told, right there, to answer with
        // a widget: the standing prompt alone loses to a history of building
        // files, pages or Claude Code mods instead.
        if (widgetsOn(readAgentSettings(project.agent)) && !thread.parentThreadId && asksForWidget(text)) {
          prompt = `${prompt}\n\n${WIDGET_TURN_NUDGE}`;
          await append([{ type: "context.injected", threadId, source: "system_prompt", content: WIDGET_TURN_NUDGE }]);
        }

        // Plan mode: a draft is told to plan and ask, read-only; a run is
        // handed the plan it carries out, so it holds after a compaction.
        if (plan) {
          const planned = await this.#planPrompt(threadId, plan, prompt);
          if (planned !== prompt) {
            await append([{ type: "context.injected", threadId, source: "system_prompt", content: planned.slice(0, planned.length - prompt.length).trim() }]);
          }
          prompt = planned;
        }

        // The first turn on a harness the thread was switched to: its session
        // is new, and starts from the brief of the work so far. Only a bound
        // thread can have been switched; a new one has nothing to read.
        if (thread.provider && !thread.providerSessionId) {
          const brief = await this.#pendingBrief(threadId);
          if (brief) prompt = handoffMessage(brief, prompt);
        }

        // A session the CLI no longer has -- Claude Code deletes transcripts
        // after 30 days, and a settled session reopened weeks later asks for
        // one -- cannot be resumed: `--resume` would fail the turn at once.
        // A new session starts instead, with a recap of the conversation.
        // Looked for where the CLI will look: its folder for this tree.
        let resumeToken = thread.providerSessionId;
        if (resumeToken && !subagentId && (provider === "claude" || provider === "codex") && this.options.providers) {
          const providers = this.options.providers;
          const token = resumeToken;
          // A check that cannot run keeps the session: resuming is the usual case.
          const gone = await Promise.resolve()
            .then(() => cliTranscriptExists(providers.credsDir(owner.id, provider, profile), provider, token, workspace))
            .then((exists) => !exists, () => false);
          if (gone) {
            resumeToken = null;
            // What the agent could still see: nothing from before a clear.
            const history = await this.store.threadHistory(threadId);
            const exchanges = exchangesOf(sinceCleared(history.map((stored) => stored.event)).map((event) => ({ event })));
            // The message being sent is the last exchange, not yet answered.
            if (exchanges.at(-1)?.reply === "") exchanges.pop();
            // Within what the new session can hold beside the message and its work (plan2 §3.5).
            const budget = handoffBudgetTokens({
              windowTokens: cliContextWindow(provider, cliModel ?? null),
              messageTokens: estimateTokens(prompt.length),
              images: pictures.length,
              files: Math.max(0, (images?.length ?? 0) - pictures.length),
            });
            const recap = conversationRecap(exchanges, handoffBudgetChars(budget));
            if (recap) {
              await append([{ type: "context.injected", threadId, source: "system_prompt", content: recap }]);
              prompt = `<earlier-conversation>\n${recap}\n</earlier-conversation>\n\n${prompt}`;
            }
          }
        }

        // A resumed session that will not fit this message, or one big and
        // idle past its cache's life, is compacted in place first
        // (plan2 §3.4, §3.7) -- under this turn, so the divider is its own.
        // What the thread keeps of the session, as the CLI turn reads it.
        const session = { sessionPrefix: thread.sessionPrefix ?? null, contextReading: thread.contextReading ?? null };
        if (resumeToken && !subagentId && !thread.parentThreadId && (provider === "claude" || provider === "codex")) {
          const reading = thread.contextReading?.harness === provider ? thread.contextReading : null;
          let compactFirst = false;
          if (provider === "claude" && !thread.resumeCompactPromptOff && offerCompactOnResume(reading, Date.now())) {
            compactFirst = (await this.#askCompactOnResume(threadId, reading!, controller.signal, append)) === "compact";
          }
          const files = Math.max(0, (images?.length ?? 0) - pictures.length);
          if (!compactFirst && overWindow({ reading, messageTokens: estimateTokens(prompt.length), images: pictures.length, files })) {
            compactFirst = true;
          }
          if (compactFirst && !controller.signal.aborted) {
            const made = await this.#compactSession(
              { ...thread, providerSessionId: resumeToken },
              owner,
              provider,
              profile,
              controller.signal,
              { turnId },
            ).catch((error: unknown) => {
              // The CLI still folds its own context mid-turn: the turn goes on.
              this.onError(new Error(`compacting ${threadId} before its turn failed: ${error instanceof Error ? error.message : String(error)}`));
              return [] as DomainEvent[];
            });
            if (made.length > 0) {
              await append(made);
              const folded = made.find((event) => event.type === "context.usage");
              if (folded?.type === "context.usage") session.contextReading = readingOf(folded);
              // Codex's history lost its instructions with the rest (plan2 §2.5).
              if (provider === "codex" && session.sessionPrefix) session.sessionPrefix = { ...session.sessionPrefix, resend: true };
            }
          }
          if (controller.signal.aborted) {
            await append([
              { type: "agent.turn_completed", threadId, turnId, stopReason: "cancelled", usage: researched?.usage ?? ZERO_USAGE, costUsd: researched?.costUsd ?? 0 },
            ]);
            return;
          }
        }

        await this.#runCli(provider, {
          ownerId: owner.id,
          owner,
          profile,
          threadId,
          turnId,
          projectId: thread.projectId,
          workspace,
          text: prompt,
          ...(subagentId ? { subagentId } : {}),
          ...(subagentId && subagentHandle ? { subagentHandle } : {}),
          subagent: Boolean(thread.parentThreadId),
          resumeToken,
          model: cliModel,
          effort,
          signal: controller.signal,
          append,
          agentSettings: readAgentSettings(project.agent),
          trusted: project.ompTrusted === true,
          ...(mode ? { mode } : {}),
          ...(plan === "draft" ? { readOnly: true } : {}),
          ...(noWeb ? { noWeb: true } : {}),
          ...(turnKnowledge?.dirs.length ? { readDirs: turnKnowledge.dirs } : {}),
          ...(researched ? { researched } : {}),
          ...(pictures.length ? { images: pictures } : {}),
          session,
        });
        // A plan's usage limit (Claude Code, Codex) or the OpenRouter key's (OMP).
        return limited ? provider : undefined;
      }

      const resolvedModel = resolveModel(model, owner.defaultModel, this.options.defaultModel);
      await append([{ type: "turn.started", threadId, turnId, model: resolvedModel, provider }]);

      // Checked after the turn is open, so a missing key surfaces as a failed
      // turn in the conversation rather than as a message that was never
      // answered by anything. A model picked under a named key bills that
      // key, at that key's provider.
      const route = await this.#nativeRoute(owner, resolvedModel);
      const apiKey = route.apiKey;

      // The clone reactor fills this in on `project.created`, but a turn
      // can start while that clone is still running, or after one that
      // failed. An empty directory makes the file tools behave sanely
      // rather than failing with an error about the harness's own layout.
      await this.#prepareWorkspace(workspace);

      const history = await this.store.threadHistory(threadId);

      // Looked up per turn rather than held: the model can change between
      // turns, and the catalogue behind this is cached anyway.
      const [contextLength, canSeeImages] = await Promise.all([route.contextLength(), route.supportsImages()]);
      const describeImage = canSeeImages ? undefined : await this.#imageDescriber(thread.projectId, owner);

      await runTurn({
        projectId: thread.projectId,
        threadId,
        turnId,
        apiKey,
        model: route.model,
        // OpenRouter's scale stops at high; Claude Code's levels above it are
        // clamped here rather than sent on to be refused.
        ...(effort ? { effort: effort === "xhigh" || effort === "max" ? "high" : effort } : {}),
        history: history.map((row) => row.event),
        instructions: [
          ...(this.messaging ? [COLLABORATION_GUIDE, !thread.parentThreadId ? UCCH_AGENT_GUIDE : ""] : []),
          // A subagent's own session reports to its parent (plan1 §2.2).
          ...(thread.parentThreadId ? [UCCH_SUBAGENT_RULES] : []),
          // Plan mode rides in the system prompt here: the history is the log.
          ...(plan ? [(await this.#planPrompt(threadId, plan, "")).trim()] : []),
          ...(turnKnowledge ? [turnKnowledge.prompt] : []),
        ].filter(Boolean).join("\n\n") || undefined,
        stack: project.stack,
        // The preset and the mode travel together: each mode's prompt
        // describes its own tools, and only its preset offers them. A plan
        // draft reads only.
        preset: plan === "draft" ? "readonly" : (mode ?? "standard"),
        ...(mode === "research" ? { mode, research: this.options.research } : {}),
        ...(mode === "documentation" ? { mode, documents: this.options.documents } : {}),
        // The workspace's "Allow interactive widgets": the prompt section
        // and `show_widget` together.
        registry: {
          ...this.options.registry,
          browser: await this.#browserToolset(readAgentSettings(project.agent), threadId, history),
          widgets: widgetsOn(readAgentSettings(project.agent)) && !thread.parentThreadId,
          ...(noWeb ? { web: false } : {}),
          ...(this.messaging ? { coordination: (name, args, ctx) => this.#coordinate(name, args, ctx), subagents: !thread.parentThreadId } : {}),
        },
        contextLength,
        supportsImages: canSeeImages,
        ...(describeImage ? { describeImage } : {}),
        searchModel: this.options.searchModel,
        maxIterations: this.options.maxIterations,
        executor: new HostExecutor(workspace, {
          heavyJobs: this.options.heavyJobs,
          wrapArgv: this.options.wrapArgv,
          pathPrefix: () => this.options.runtimePath?.(workspace) ?? null,
          ...(turnKnowledge?.dirs.length ? { readOnlyRoots: turnKnowledge.dirs } : {}),
        }),
        ...(this.options.uploads ? { uploads: this.options.uploads } : {}),
        ...(this.#browserOn(readAgentSettings(project.agent)) ? { browser: this.#browserFor(thread.projectId, threadId, workspace) } : {}),
        complete: route.complete,
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
      // The native loop's OpenRouter key out of credits is a limit too.
      const limit = runsOn === "native" && isOpenRouterLimit(message);
      await append([{ type: "agent.turn_failed", threadId, turnId, error: message, ...(limit ? { limit: true as const } : {}) }]).catch(
        this.onError,
      );
    } finally {
      if (this.#spawnCalls.get(threadId) === spawnCalls) this.#spawnCalls.delete(threadId);
      release?.();
      // The tail of the answer, should the turn have ended without anything
      // durable after its last token.
      coalescer.dispose();
      // After the turn, not during it: a slow disk must not hold the
      // conversation up, and a failure here is never the turn's.
      void this.#recheckStack(thread.projectId, workspace).catch(this.onError);
    }
    return limited ? runsOn : undefined;
  }

  /**
   * The brief a harness switch left for the thread's next session: the
   * last `thread.harness_switched`, until a session has opened since it
   * (which was handed it). A first turn that failed before its CLI named a
   * session leaves it for the next one.
   */
  async #pendingBrief(threadId: string): Promise<string | null> {
    const history = await this.store.threadHistory(threadId);
    let brief: string | null = null;
    for (const { event } of history) {
      if (event.type === "thread.harness_switched") brief = event.brief;
      // A clear after a switch empties that brief with the rest.
      else if (event.type === "agent.session_started" || event.type === "thread.context_cleared") brief = null;
    }
    return brief;
  }

  /**
   * A big Claude Code session whose cache ran out while it sat idle (plan2
   * §3.7): before its message goes, the person is asked once whether to
   * compact it first -- sent as it is, the whole history is paid for again
   * at full price. "Don't ask again" is the thread's
   * (`threads.resume_compact_prompt_off`). A stop answers it as "keep".
   */
  async #askCompactOnResume(
    threadId: string,
    reading: ContextReading,
    signal: AbortSignal,
    append: (events: readonly DomainEvent[]) => Promise<unknown>,
  ): Promise<string | null> {
    const requestId = randomUUID();
    const idleMs = Math.max(0, Date.now() - Date.parse(reading.at));
    const age = idleMs >= 3_600_000 ? `${Math.round(idleMs / 3_600_000)}h` : `${Math.max(1, Math.round(idleMs / 60_000))}m`;
    const tokens = `${Math.round((reading.usedTokens ?? 0) / 1000)}k`;
    await append([
      {
        type: "agent.choice_requested",
        threadId,
        requestId,
        kind: "resume_compact",
        title: `This session is ${age} old and uses ${tokens} tokens — compact before continuing?`,
        detail:
          "Its prompt cache has expired, so this message would send the whole conversation again at full price. Compacting folds it into a summary in the same session first.",
        options: [
          { id: "compact", label: "Compact first" },
          { id: "keep", label: "Keep as is" },
          { id: "never", label: "Don't ask again" },
        ],
      },
    ]);
    const answer = await this.#choices.wait(requestId, signal);
    await append([{ type: "agent.choice_resolved", threadId, requestId, optionId: answer.optionId }]);
    if (answer.optionId === "never") {
      await this.db.update(threads).set({ resumeCompactPromptOff: true }).where(eq(threads.id, threadId));
    }
    return answer.optionId;
  }

  /**
   * Compacts a Claude Code or Codex session in place (plan2 §3.2), and
   * returns what it made: the chat's "Context compacted" divider and the
   * reading after it.
   *
   * - Claude Code: `/compact` as a turn of the same session (`--resume`,
   *   the message on stream-json stdin, which 2.1.330 runs headless), with
   *   the session's own prefix and tools, so the summary's call reads the
   *   history from the cache. Its `compact_boundary` and the summary after
   *   it are the divider (`ClaudeNormaliser`).
   * - Codex: the app server's `thread/compact/start` (`compactCodexThread`):
   *   `exec` sends `/compact` to the model as a message. Its history lost
   *   the first turn's instructions with it, so the next turn hands them
   *   over again (`SessionPrefix.resend`).
   *
   * `turn`: under a turn (§3.4, §3.7), whose slot it runs in; otherwise the
   * caller holds one. Nothing is billed: the CLI reports the summary's call
   * as no usage, and between turns there is no turn to bill.
   */
  async #compactSession(
    thread: typeof threads.$inferSelect,
    owner: TurnOwner,
    provider: "claude" | "codex",
    profile: ProfileRef | null,
    signal: AbortSignal,
    turn?: { turnId: string },
  ): Promise<DomainEvent[]> {
    const providers = this.options.providers;
    if (!providers || !this.options.cliEnabled) throw new Error(`${harnessLabel(provider)} is disabled on this server`);
    const resumeToken = thread.providerSessionId;
    if (!resumeToken) throw new Error("there is no conversation to compact yet");
    const workspace = treeFor(this.options.workspaceRoot, thread.projectId, thread);
    const prefix = thread.sessionPrefix?.provider === provider && thread.sessionPrefix.sessionId === resumeToken ? thread.sessionPrefix : null;
    // What the session runs on: its prefix names it, else its last turn did.
    const [last] = await this.db
      .select({ model: turns.model })
      .from(turns)
      .where(eq(turns.threadId, thread.id))
      .orderBy(desc(turns.seq))
      .limit(1);
    const model = prefix?.model ?? last?.model ?? undefined;
    const ids = turn ? { turnId: turn.turnId } : {};

    if (provider === "codex") {
      const resolved = await providers.resolve(owner.id, "codex", profile ? { profile } : {});
      const codex = resolved.provider as { compact?: (input: import("@ucch/providers").ProviderCompactInput) => Promise<DomainEvent[]> };
      if (!codex.compact) throw new Error("this server's Codex provider cannot compact a session");
      const made = await codex.compact({
        ctx: resolved.ctx(workspace),
        threadId: thread.id,
        resumeToken,
        ...(model ? { model } : {}),
        signal,
      });
      if (prefix) {
        await this.db.update(threads).set({ sessionPrefix: { ...prefix, resend: true } }).where(eq(threads.id, thread.id));
      }
      return made.map((event) => ({ ...event, ...ids }));
    }

    const [project] = await this.db
      .select({ agent: workspaces.agentSettings, ompTrusted: projects.ompTrusted })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.id, thread.projectId))
      .limit(1);
    const kept: DomainEvent[] = [];
    let failure: string | null = null;
    let compacted = false;
    await this.#runCli("claude", {
      ownerId: owner.id,
      owner,
      profile,
      threadId: thread.id,
      // The bridge and the config files are named by it; nothing is stored under it.
      turnId: turn?.turnId ?? randomUUID(),
      projectId: thread.projectId,
      workspace,
      text: "/compact",
      resumeToken,
      model,
      effort: prefix?.effort && isEffort(prefix.effort) ? prefix.effort : undefined,
      signal,
      agentSettings: readAgentSettings(project?.agent),
      trusted: project?.ompTrusted === true,
      subagent: Boolean(thread.parentThreadId),
      compaction: true,
      session: { sessionPrefix: thread.sessionPrefix ?? null, contextReading: thread.contextReading ?? null },
      // Only the compaction's own record: no turn opened, so nothing that
      // closes or belongs to one may land.
      append: async (events) => {
        for (const event of events) {
          if (event.type === "agent.turn_failed") failure = event.error;
          else if (event.type === "agent.turn_completed" && event.stopReason === "cancelled") failure = "Stopped.";
          else if (event.type === "context.injected" && event.source === "compaction") {
            compacted = true;
            kept.push(turn ? event : withoutTurn(event));
          } else if (event.type === "context.usage") {
            kept.push(turn ? event : withoutTurn(event));
          }
        }
      },
    });
    if (failure) throw new Error(failure);
    if (!compacted) throw new Error("Claude Code answered /compact without compacting the session");
    return kept;
  }

  /**
   * `thread.compact` / `thread.handoff` (solution §5.3, plan2 §3.2), between
   * turns: the session's own compaction -- Claude Code's `/compact`,
   * Codex's app server (`#compactSession`), or OMP's command in a short
   * process of its own. No turn opens -- nothing is asked of the model but
   * the summary -- so what it made lands as a `context.injected` with no
   * turn, which the chat draws under the last answer, and the reading the
   * meter shows after it.
   *
   * It takes a slot like a turn, and a stop reaches it like a turn's
   * (`#running`). Every way out ends with `thread.compaction_finished`,
   * which is what frees the thread the request claimed. One the server
   * asked for (`auto`) that fails hands the session over instead, as a
   * brief on the same harness (`thread.handoff { fallback }`); an idle one
   * that fails is left: nothing is waiting on it.
   */
  async #compact(
    threadId: string,
    method: "compact" | "handoff",
    focus: string | undefined,
    flags: { auto: boolean; idle: boolean } = { auto: false, idle: false },
  ): Promise<void> {
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
      if (thread.provider === "claude" || thread.provider === "codex") {
        const provider = thread.provider;
        release = await this.#scheduler.acquire({ ownerId: owner.id, kind: turnKindOf(provider), threadId, signal: controller.signal });
        const account = await this.#profileFor(thread.projectId, owner, thread.profileId, provider);
        made = await this.#compactSession(thread, owner, provider, account ? toRef(account) : null, controller.signal);
      } else {
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
      }
    } catch (caught) {
      error = controller.signal.aborted ? "Stopped." : caught instanceof Error ? caught.message : String(caught);
    } finally {
      release?.();
      await overlay?.dispose().catch(this.onError);
      if (this.#running.get(threadId) === controller) this.#running.delete(threadId);
      // The due time this was armed for is spent, however it went.
      if (flags.idle) await this.db.update(threads).set({ idleCompactAt: null }).where(eq(threads.id, threadId)).catch(this.onError);
      const events: DomainEvent[] = [
        ...made,
        { type: "thread.compaction_finished", threadId, method, ...(error ? { error: error.slice(0, 2_000) } : {}) },
      ];
      await this.store
        .append({ projectId: thread.projectId, threadId }, events, (tx) => applyProjection(tx, events, null))
        .catch(this.onError);
    }
    // Neither method asks the model anything more: a handover replaces the
    // context with its brief and then waits, so the person's next message
    // is the first turn on it.
    if (error && flags.auto && !flags.idle && !controller.signal.aborted) {
      const dispatch = this.options.dispatch;
      const principal = await this.#internalPrincipal(thread);
      if (!dispatch || !principal) return;
      const result = await dispatch(principal, { type: "thread.handoff", threadId, auto: true, fallback: true });
      if (!result.ok) this.onError(new Error(`handover of ${threadId} after a failed compaction refused: ${result.message}`));
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
    const stopped = () => {
      if (controller.signal.aborted) throw new Error("Stopped.");
    };
    try {
      const dispatch = this.options.dispatch;
      if (!dispatch || !principal) throw new Error("this server cannot start a thread for a handoff");
      const { brief, note } = await this.#writeBrief(thread, event.focus, controller.signal, {
        provider: event.targetProvider,
        message: event.message,
      });
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
        ...(note ? { briefNote: note } : {}),
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
   * The brief of a thread's work so far (solution §5.4, plan2 §3.5), for the
   * session that carries it on, written by the first of these that can:
   *
   * 1. OMP: the log as a transcript, on stdin to a one-shot
   *    `omp -p --no-session --no-tools` on the overlay's `smol` role, billed
   *    as an OMP call is (the account's OpenRouter key, an OMP slot);
   * 2. the thread's own harness, one-shot (`claude -p`, `codex exec
   *    --ephemeral`), on its subscription, when OMP or the key is missing;
   * 3. the conversation itself, as it was said (`conversationRecap`), when
   *    neither could -- never a handover that fails for want of a writer.
   *
   * Every one is held to what the new session can take beside the message
   * and its work (`handoffBudgetTokens`, after t3code's `handoffBudget`).
   * `note` says why it is not OMP's, for the thread to show.
   */
  async #writeBrief(
    thread: typeof threads.$inferSelect,
    focus: string | undefined,
    signal: AbortSignal,
    target: { provider: ProviderId; model?: string | undefined; message?: string | undefined },
  ): Promise<{ brief: string; note?: string }> {
    const history = await this.store.threadHistory(thread.id);
    // What the agent can still see: nothing from before a clear.
    const events = sinceCleared(history.map((stored) => stored.event));
    const tokens = handoffBudgetTokens({
      windowTokens: cliContextWindow(target.provider, target.model ?? null) ?? (target.provider === "native" || target.provider === "omp" ? 128_000 : null),
      messageTokens: estimateTokens(target.message?.length ?? 0),
    });
    const chars = handoffBudgetChars(tokens);
    const clip = (text: string) => (text.length > chars ? `${text.slice(0, chars)}\n\n[… the brief ran past its budget and was cut]` : text);
    const failures: string[] = [];
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

    try {
      return { brief: clip(await this.#ompBrief(thread, events, focus, signal, tokens)) };
    } catch (error) {
      if (signal.aborted) throw new Error("Stopped.");
      failures.push(`OMP could not write it: ${reason(error)}`);
    }
    const own = thread.provider;
    if (own === "claude" || own === "codex") {
      try {
        const brief = await this.#harnessBrief(thread, own, events, focus, signal, tokens);
        return { brief: clip(brief), note: `${harnessLabel(own)} wrote this brief: ${failures.join("; ")}.` };
      } catch (error) {
        if (signal.aborted) throw new Error("Stopped.");
        failures.push(`${harnessLabel(own)} could not either: ${reason(error)}`);
      }
    }
    const recap = conversationRecap(exchangesOf(events.map((event) => ({ event }))), chars);
    if (!recap) throw new Error(`this thread has nothing to hand off yet (${failures.join("; ")})`);
    return {
      brief: recap,
      note: `No brief could be written, so the conversation so far was handed over as it was said. ${failures.join("; ")}.`.slice(0, 2_000),
    };
  }

  /** The brief as OMP writes it: the first way `#writeBrief` tries. */
  async #ompBrief(
    thread: typeof threads.$inferSelect,
    events: readonly DomainEvent[],
    focus: string | undefined,
    signal: AbortSignal,
    tokens: number,
  ): Promise<string> {
    const owner = await this.#owner(thread.projectId, thread);
    if (!owner) throw new Error("there is nobody to bill this thread to");
    const providers = this.options.providers;
    if (!providers || !this.options.cliEnabled) throw new Error("OMP is disabled on this server");
    // The key first: a missing one says where to add it.
    const openrouterKey = this.#decryptKey(owner.openrouterKeyEncrypted);
    const release = await this.#scheduler.acquire({ ownerId: owner.id, kind: "omp", threadId: thread.id, signal });
    let overlay: { dispose(): Promise<void> } | undefined;
    try {
      if (signal.aborted) throw new Error("Stopped.");
      const resolved = await providers.resolve(owner.id, "omp", { openrouterKey, ompPreset: "standard" });
      const omp = resolved.provider as Partial<BriefAsker>;
      if (!omp.ask) throw new Error("this server's OMP provider cannot write a brief");
      const written = await writeOmpOverlay(providers.ompRunDir(owner.id), randomUUID(), {
        settings: { ...DEFAULT_OMP_SETTINGS, models: { default: this.options.searchModel } },
        preset: "standard",
        permissionMode: this.#modeFor(thread.id, owner),
        // A brief runs `--no-tools`: nothing for a trusted project's config to add.
        trusted: false,
        workersPerTurn: this.options.ompWorkersPerTurn ?? 4,
        webSearch: false,
        hostTools: [],
      });
      overlay = written;
      return await buildHandoffBrief({
        omp: omp as BriefAsker,
        ctx: resolved.ctx(treeFor(this.options.workspaceRoot, thread.projectId, thread)),
        files: { overlayPath: written.path, guardHookPath: providers.ompGuardHook(owner.id) },
        events,
        ...(focus ? { focus } : {}),
        briefTokens: tokens,
        signal,
      });
    } finally {
      // The slot was for OMP; whatever turn follows takes its own.
      release();
      await overlay?.dispose().catch(this.onError);
    }
  }

  /**
   * The brief as the thread's own Claude Code or Codex writes it, one-shot
   * on its subscription: no tools, no session kept (`ask`). On a slot of
   * the harness's, like a turn.
   */
  async #harnessBrief(
    thread: typeof threads.$inferSelect,
    provider: "claude" | "codex",
    events: readonly DomainEvent[],
    focus: string | undefined,
    signal: AbortSignal,
    tokens: number,
  ): Promise<string> {
    const owner = await this.#owner(thread.projectId, thread);
    if (!owner) throw new Error("there is nobody to bill this thread to");
    const providers = this.options.providers;
    if (!providers || !this.options.cliEnabled) throw new Error(`${harnessLabel(provider)} is disabled on this server`);
    const transcript = renderTranscript(events);
    if (!transcript) throw new Error("this thread has nothing to hand off yet");
    const account = await this.#profileFor(thread.projectId, owner, thread.profileId, provider);
    const profile = account ? toRef(account) : null;
    const release = await this.#scheduler.acquire({ ownerId: owner.id, kind: turnKindOf(provider), threadId: thread.id, signal });
    try {
      if (signal.aborted) throw new Error("Stopped.");
      const resolved = await providers.resolve(owner.id, provider, profile ? { profile } : {});
      const asker = resolved.provider as { ask?: (input: import("@ucch/providers").ProviderAskInput) => Promise<string> };
      if (!asker.ask) throw new Error(`this server's ${harnessLabel(provider)} provider cannot write a brief`);
      return await asker.ask({
        ctx: resolved.ctx(treeFor(this.options.workspaceRoot, thread.projectId, thread)),
        prompt: `${handoffPrompt(focus, tokens)}\n\n<transcript>\n${transcript}\n</transcript>\n`,
        signal,
      });
    } finally {
      release();
    }
  }

  /**
   * `thread.switch_harness`: the same thread, on another harness from its
   * next turn. The brief of its work so far is written (`#writeBrief`) and
   * recorded with the switch, which rebinds the thread and drops its old
   * session; the next turn's new session starts from the brief
   * (`#pendingBrief`), and the native loop folds the log into it as it
   * folds a compaction. With a message -- the one a limit stopped -- that
   * turn is started at once.
   *
   * The thread is busy from the request until the switch is recorded, and
   * a stop ends the brief there.
   */
  async #switchHarness(
    event: Extract<DomainEvent, { type: "thread.harness_switch_requested" }>,
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
    // "Custom" is OMP where it is on, as a new thread's would be.
    const toProvider: ProviderId =
      event.targetProvider === "native" && this.#customProvider() === "omp" ? "omp" : event.targetProvider;
    let switched: Extract<DomainEvent, { type: "thread.harness_switched" }> | undefined;
    let error: string | undefined;
    try {
      // The work so far, committed on the session's branch before anyone
      // else picks it up: the new harness or account starts from a commit
      // that can be gone back to, whatever it does next.
      const checkpointSha = await this.#checkpoint(thread, event).catch((caught: unknown) => {
        this.onError(caught);
        return null;
      });
      const { brief, note } = await this.#writeBrief(thread, event.focus, controller.signal, {
        provider: toProvider,
        model: event.model,
        message: event.message,
      });
      if (controller.signal.aborted) throw new Error("Stopped.");
      switched = {
        type: "thread.harness_switched",
        threadId,
        fromProvider: event.fromProvider,
        toProvider,
        ...(event.model ? { model: event.model } : {}),
        brief,
        ...(note ? { briefNote: note } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.fromProfileId !== undefined ? { fromProfileId: event.fromProfileId } : {}),
        ...(event.toProfileId !== undefined ? { toProfileId: event.toProfileId } : {}),
        ...(checkpointSha ? { checkpointSha } : {}),
        ...(event.auto ? { auto: true } : {}),
      };
    } catch (caught) {
      error = controller.signal.aborted ? "Stopped." : caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (this.#running.get(threadId) === controller) this.#running.delete(threadId);
      const events: DomainEvent[] = [
        switched && !error ? switched : { type: "thread.harness_switch_failed", threadId, error: (error ?? "the switch failed").slice(0, 2_000) },
      ];
      await this.store
        .append({ projectId: thread.projectId, threadId }, events, (tx) => applyProjection(tx, events, null))
        .catch(this.onError);
    }
    // A handover on the same harness carries no message: the person's next
    // one is the first turn on the brief.
    if (!switched || error || !event.message) return;
    const dispatch = this.options.dispatch;
    if (!dispatch || !principal) return;
    const sent = await dispatch(principal, {
      type: "thread.send",
      threadId,
      text: event.message,
      provider: toProvider,
      ...(event.model ? { model: event.model } : {}),
      ...(event.effort && isEffort(event.effort) ? { effort: event.effort } : {}),
    });
    if (!sent.ok) this.onError(new Error(`the message after switching ${threadId} could not be sent: ${sent.message}`));
  }

  /**
   * Commits everything in a session's worktree before a switch, and returns
   * the commit. Null -- nothing to do -- for a thread with no worktree of
   * its own (it shares the project's checkout, whose history is the
   * person's), or a tree that is not ready. `--allow-empty`, so the switch
   * is marked on the branch even when nothing changed since the last one.
   */
  async #checkpoint(
    thread: { projectId: string; branch: string | null; worktreeState: string | null; hash: string; treeHash: string | null },
    event: Extract<DomainEvent, { type: "thread.harness_switch_requested" }>,
  ): Promise<string | null> {
    if (!thread.branch || thread.worktreeState !== "ready") return null;
    const tree = treeFor(this.options.workspaceRoot, thread.projectId, thread);
    const who = ["-c", "user.name=UltraChillCodingHarness", "-c", "user.email=harness@localhost"];
    const reason = event.reason === "limit" ? "usage limit" : event.reason === "context" ? "context handover" : "switch";
    const message = `ucch: checkpoint before handoff (${reason}, ${harnessLabel(event.fromProvider)} -> ${harnessLabel(event.targetProvider)})`;
    await runGit(["add", "-A"], tree, 60_000);
    await runGit([...who, "commit", "--allow-empty", "--no-verify", "-m", message], tree, 60_000);
    return (await runGit(["rev-parse", "HEAD"], tree, 10_000, { read: true })).trim() || null;
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
   * Copies a message's attachments into the turn's workspace
   * (`UploadStore.materialize`) and returns the pictures among them for a
   * CLI that can be shown them.
   *
   * Only into a workspace that already has something in it: a project whose
   * clone is still queued must find its directory empty, and the message's
   * inlined text still carries what fits. Each picture is retained as it is
   * read, as the native loop does, so a thread replayed later still has it.
   */
  async #placeAttachments(
    projectId: string,
    workspace: string,
    text: string,
    images: readonly MessageImage[] | undefined,
  ): Promise<ProviderImage[]> {
    const staging = this.options.uploads;
    if (!staging?.materialize) return [];
    const ids = new Set(parseAttachmentManifest(text).attachments.map((a) => a.uploadId).filter((id): id is string => Boolean(id)));
    for (const image of images ?? []) ids.add(image.uploadId);
    if (ids.size === 0) return [];
    const entries = await readdir(workspace).catch(() => [] as string[]);
    if (entries.length === 0) return [];

    const placed = new Map<string, string>();
    for (const id of ids) {
      const where = await staging.materialize(projectId, id, workspace).catch((error: unknown) => {
        this.onError(error);
        return null;
      });
      if (where) placed.set(id, join(workspace, where.file));
    }

    const pictures: ProviderImage[] = [];
    for (const image of images ?? []) {
      const path = placed.get(image.uploadId);
      if (!path || !isModelImageType(image.type)) continue;
      await staging.retain(projectId, image.uploadId).catch(() => {});
      const file = await staging.readBytes(projectId, image.uploadId).catch(() => null);
      if (!file || !isModelImageType(file.contentType)) continue;
      pictures.push({ path, mediaType: file.contentType.split(";")[0]!.trim(), data: file.bytes.toString("base64") });
    }
    return pictures;
  }

  /**
   * For a model that cannot see: a describer that puts each attached picture
   * into words (`describe-image.ts`), by the search model -- cheap, fast, and
   * able to see by default -- on the owner's OpenRouter key. Undefined when
   * there is no key, no staging, or the search model cannot see either: the
   * turn then names the picture as attached and unseen, as before.
   */
  async #imageDescriber(
    projectId: string,
    owner: { openrouterKeyEncrypted: string | null },
  ): Promise<((uploadId: string, signal?: AbortSignal) => Promise<string | null>) | undefined> {
    const staging = this.options.uploads;
    const model = this.options.searchModel;
    if (!staging || !model || !owner.openrouterKeyEncrypted) return undefined;
    if (!(await supportsImages(model).catch(() => false))) return undefined;
    let apiKey: string;
    try {
      apiKey = this.#decryptKey(owner.openrouterKeyEncrypted);
    } catch {
      return undefined;
    }
    return stagedImageDescriber({ staging, projectId, complete: streamCompletion, apiKey, model, onError: this.onError });
  }

  /**
   * The workspace as every turn expects to find it: there, and with its
   * `.agent/index.md`. Run before every turn of every harness, which is what
   * gives a project made before `.agent` existed its folder.
   *
   * Only once the checkout exists: `git clone` refuses a directory that is
   * not empty, so a `.agent` written while the clone is still queued would
   * fail it -- and the clone writes the folder itself when it lands. A
   * `.agent` the harness cannot write -- a symlink, a file of that name -- is
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
      /** The subscription account a Claude Code or Codex turn signs in as; null for its Default. */
      profile?: ProfileRef | null;
      threadId: string;
      turnId: string;
      projectId: string;
      workspace: string;
      text: string;
      subagentId?: string;
      subagentHandle?: string;
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
       * A plan-mode draft: nothing may change. Claude Code runs in its plan
       * permission mode, Codex in a read-only sandbox, and OMP asks the
       * person before anything but a read.
       */
      readOnly?: boolean;
      /** A knowledge-only turn: the CLI's own web tools are switched off. */
      noWeb?: boolean;
      /** Folders outside the tree the CLI may read: this turn's knowledge bases. */
      readDirs?: string[];
      /**
       * What a research phase already spent on this turn. Folded into the
       * CLI's `agent.turn_completed`, which is the one event the usage
       * breakdown reads -- a phase that closed the turn itself would have
       * moved the thread to idle with the CLI still to run.
       */
      researched?: { usage: TokenUsage; costUsd: number };
      /** Pictures attached to the message, for a CLI that can be shown them. */
      images?: readonly ProviderImage[];
      /** A subagent's own session: it is not offered `ucch_agent`. */
      subagent?: boolean;
      /**
       * A `/compact` of the session (`#compactSession`): the session's own
       * prefix and tools, and nothing of a turn's -- no knowledge update in
       * front of the command, no log of the instructions, no retention.
       */
      compaction?: boolean;
      /**
       * What the thread keeps of its CLI session (`threads.session_prefix`,
       * `threads.context_reading`), from the row the caller read.
       */
      session?: { sessionPrefix: SessionPrefix | null; contextReading: ContextReading | null };
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
    let recall: OpenedMemory | undefined;
    let bridge: (Pick<ProviderRunInput, "mcpConfigPath" | "codexMcp"> & { omp: boolean; dispose(): Promise<void> }) | null = null;
    try {
      await this.#prepareWorkspace(input.workspace);
      const knowledge = await readProjectKnowledge(input.workspace).catch((error: unknown) => {
        this.onError(error);
        return null;
      });
      // A Claude Code or Codex session keeps what it started with (plan2
      // §2.3, §2.4): the thread's stored prefix and tools, and the reading
      // its last call left, whose cache lifetime this turn's carries on.
      const session = provider === "claude" || provider === "codex" ? provider : null;
      const kept = session && !input.subagentId ? input.session ?? null : null;
      const stored =
        kept?.sessionPrefix && kept.sessionPrefix.provider === session && input.resumeToken && kept.sessionPrefix.sessionId === input.resumeToken
          ? kept.sessionPrefix
          : null;
      const previous = kept?.contextReading?.harness === session ? kept?.contextReading ?? null : null;
      // Before the instructions: whether the turn has the bridge decides
      // whether they carry its guide.
      // Subagents on any harness, for every session but a subagent's own.
      // A resumed session's bridge carries the tools it started with, as far
      // as the server can still give them: a setting changed mid-session
      // takes effect in its next session, so the tool list -- the front of
      // the cached prefix -- holds.
      const offersSubagents = this.#subagents !== null && !input.subagent && (stored ? stored.tools.subagents : true);
      const ompTools = stored ? stored.tools.omp : input.agentSettings?.ompBridge.enabled === true;
      // Interactive widgets: taught in the instructions (the fence works on
      // every harness), and `show_widget` on the bridge. Not for a
      // subagent, whose answer goes to its parent rather than the reader.
      const widgets = !input.subagent && (stored ? stored.tools.widgets : widgetsOn(input.agentSettings));
      const messaging = Boolean(this.messaging) && (stored ? stored.tools.messaging : true);
      // The shared browser, on the bridge: a resumed session keeps the tool
      // list it started with, so one from before the browser stays without.
      const browserTools = provider !== "omp" && (stored ? stored.tools.browser === true : this.#browserOn(input.agentSettings));
      // Codex lists every MCP tool it is given on every request, so a thread
      // that has not used the browser is handed `browser_open` alone; the
      // bridge lists the rest once it succeeds. Claude Code already keeps
      // bridge tools behind ToolSearch until asked for, so it gets them all.
      const browserOffer = !browserTools ? false : provider === "codex" ? await this.#browserToolset(input.agentSettings, input.threadId) : "full";
      if (provider !== "omp" && (ompTools || offersSubagents || widgets || messaging || browserTools)) {
        bridge = await this.#openBridge(provider, input, { omp: ompTools, subagents: offersSubagents, widgets, messaging, browser: browserOffer });
      }
      // UCCH's rules, the guides for the tools this turn really has, and the
      // runtime info (`cli-instructions.ts`). Logged part by part, as the
      // native loop logs its prompt, so the thread says exactly what the
      // CLI was handed on top of the message. Claude Code and Codex are
      // handed their session's fixed text (`planSessionPrefix`); OMP its
      // every turn.
      const build = {
        workspace: input.workspace,
        model: input.model,
        effort: input.effort,
        knowledge,
        mode: input.mode,
        planDraft: input.readOnly === true,
        subagent: input.subagent === true,
        bridge: bridge ? { omp: bridge.omp } : null,
        offersSubagents,
        messaging,
        widgets,
      };
      let instructions: string | null;
      let injected: { source: "system_prompt" | "project_context" | "omp_bridge"; content: string }[];
      let prefix: SessionPrefix | null = null;
      let text = input.text;
      if (session) {
        const plan = planSessionPrefix({
          stored: kept?.sessionPrefix ?? null,
          resumeToken: input.resumeToken,
          build: { ...build, provider: session },
          tools: { omp: ompTools, subagents: offersSubagents, messaging, widgets, ...(browserTools ? { browser: true } : {}) },
        });
        instructions = plan.instructions;
        injected = input.compaction ? [] : plan.injected;
        if (plan.messagePrefix && !input.compaction) text = `${plan.messagePrefix}\n\n${input.text}`;
        // A compaction tells the session nothing new: the notes it last saw stay the ones to diff from.
        prefix = input.compaction && stored ? { ...plan.prefix, knowledge: stored.knowledge, knowledgeSha256: stored.knowledgeSha256 } : plan.prefix;
      } else {
        ({ instructions, injected } = assembleCliInstructions({ ...build, provider, fresh: true }));
      }
      if (injected.length > 0) {
        await input.append(injected.map((part) => ({ type: "context.injected" as const, threadId: input.threadId, ...part })));
      }
      // The mode's tools and rules (solution §3.7); the guard hook reads it
      // too, to keep a documentation turn's writes under docs/.
      const preset: OmpPreset = input.mode ?? "standard";
      const resolved = await this.options.providers.resolve(input.ownerId, provider, {
        ...(openrouterKey ? { openrouterKey, ompPreset: preset } : {}),
        ...(input.profile ? { profile: input.profile } : {}),
      });
      const permissionMode = input.readOnly ? "strict" : this.#modeFor(input.threadId, input.owner);
      let omp: OmpRunFiles | undefined;
      let host: Pick<ProviderRunInput, "hostTools" | "onHostToolCall"> = {};
      if (provider === "omp") {
        const providers = this.options.providers;
        const browserOn = this.#browserOn(input.agentSettings);
        const hostTools = [
          ...hostToolSchemas(preset, { ...this.options.registry, widgets, browser: browserOn, ...(this.messaging ? { coordination: (name, args, ctx) => this.#coordinate(name, args, ctx) } : {}) }),
          ...(offersSubagents ? [UCCH_AGENT_HOST_TOOL] : []),
        ];
        // The session's bank and the ones it may recall, under the subject that pays.
        const memory = input.agentSettings?.memory ?? DEFAULT_OMP_SETTINGS.memory;
        if (memory.enabled) recall = await this.#openMemory(input, input.turnId, input.text);
        const written = await writeOmpOverlay(providers.ompRunDir(input.ownerId), input.turnId, {
          // Every model role is the turn's model until the workspace picks
          // its own (OM8.1): a role left unnamed is the repository's to set.
          settings: {
            ...DEFAULT_OMP_SETTINGS,
            models: input.model ? { default: input.model } : {},
            isolatedFanOut: input.agentSettings?.isolatedFanOut.enabled ?? false,
            memory,
          },
          ...(recall ? { memoryDbPath: recall.path } : {}),
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
            [UCCH_AGENT_TOOL, "ucch_sessions", "ucch_session_read", "ucch_message", "ucch_inbox", "ucch_agent_status", "ucch_agent_cancel"].includes(call.toolName) && hostTools.some((tool) => tool.name === call.toolName)
              ? this.#coordinate(call.toolName, call.arguments, { threadId: input.threadId, turnId: input.turnId, toolUseId: call.toolCallId, signal })
              : this.#runHostTool(call, signal, {
              ...input,
              preset,
              advertised: new Set(hostTools.map((tool) => tool.name)),
              apiKey: openrouterKey!,
              browser: browserOn,
            }),
        };
      }
      await resolved.provider.prepare?.(resolved.ctx(input.workspace)).catch(this.onError);
      run = resolved.provider.run({
        ctx: resolved.ctx(input.workspace),
        ...(input.subagentId ? { subagentId: input.subagentId } : {}),
        ...(input.subagentHandle ? { subagentHandle: input.subagentHandle } : {}),
        prompt: text,
        ...(input.images?.length ? { images: input.images } : {}),
        ...(previous?.cacheTtlMs ? { cacheTtlMs: previous.cacheTtlMs } : {}),
        projectId: input.projectId,
        threadId: input.threadId,
        turnId: input.turnId,
        ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        permissionMode,
        ...(input.readOnly ? { readOnly: true } : {}),
        ...(input.noWeb ? { noWeb: true } : {}),
        ...(input.readDirs?.length ? { readDirs: input.readDirs } : {}),
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
      // The session the CLI named, for the prefix kept with it; and whether
      // Codex compacted it mid-turn, which drops its instructions.
      let sessionId: string | null = null;
      let codexCompacted = false;
      let firstReading = true;
      const startedAt = Date.now();
      try {
        for await (const event of run.events) {
          if (event.type === "agent.message") answer = messageText(event.content) ?? answer;
          else if (event.type === "agent.turn_completed") completed = true;
          else if (event.type === "agent.session_started") {
            sessionId = event.sessionId;
            // Kept as soon as the session is named, before the turn's end
            // goes out: a message sent the moment it does reads it.
            if (prefix) await this.#keepPrefix(input.threadId, { ...prefix, sessionId });
          }
          else if (event.type === "context.injected" && event.source === "compaction" && provider === "codex") codexCompacted = true;
          else if (event.type === "context.usage" && firstReading) {
            firstReading = false;
            // A resumed session's first call that read nothing from a cache
            // that should have been warm: the prefix moved (plan2 §2.2). The
            // operator's signal, as the native loop's canary is.
            const warmUntil = previous?.cacheExpiresAt ? Date.parse(previous.cacheExpiresAt) : NaN;
            if (input.resumeToken && event.cacheHitRatio === 0 && warmUntil > startedAt) {
              this.onError(
                new Error(
                  `prompt cache missed on the first call of resumed ${provider} turn ${input.turnId} ` +
                    `(thread ${input.threadId}, prefix sha256 ${prefix?.sha256 ?? "none"}): it should have been warm until ` +
                    `${new Date(warmUntil).toISOString()} -- the session's prefix or tools changed`,
                ),
              );
            }
          }
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
      // The prefix, kept with the session it was handed to: the next turn
      // that resumes it hands it the same bytes.
      // Again only when it changed after that: no session named, or Codex
      // compacted mid-turn and dropped the instructions with its history.
      const keptSession = sessionId ?? input.resumeToken;
      if (prefix && keptSession && (sessionId === null || codexCompacted)) {
        await this.#keepPrefix(input.threadId, { ...prefix, sessionId: keptSession, resend: prefix.resend === true || codexCompacted });
      }
      const memory = input.agentSettings?.memory;
      if (provider !== "omp" && !input.compaction && completed && answer && memory?.enabled && memory.retainCliTurns) {
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
      await recall?.close();
    }
  }

  /** A session's prefix, kept with its thread (`threads.session_prefix`). */
  async #keepPrefix(threadId: string, prefix: SessionPrefix): Promise<void> {
    // Never the turn's failure: a prefix not kept is only a cache missed.
    try {
      await this.db.update(threads).set({ sessionPrefix: prefix }).where(eq(threads.id, threadId));
    } catch (error) {
      this.onError(error);
    }
  }

  /**
   * The bank file a run names in its overlay: the session's working bank
   * (`SessionMemory`), or without one the project's single bank. Closed
   * once the run's process has exited.
   */
  async #openMemory(input: { ownerId: string; projectId: string; threadId: string }, key: string, text: string): Promise<OpenedMemory> {
    const providers = this.options.providers!;
    if (!this.options.memory) return { path: providers.ompMemoryDb(input.ownerId, input.projectId), close: async () => {} };
    return this.options.memory.open({
      subject: input.ownerId,
      bank: { projectId: input.projectId, threadId: input.threadId },
      runDir: providers.ompRunDir(input.ownerId),
      key,
      text,
    });
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
    let recall: OpenedMemory | undefined;
    try {
      const resolved = await providers.resolve(input.ownerId, "omp", { openrouterKey, ompPreset: "standard" });
      const omp = resolved.provider as Partial<BriefAsker>;
      if (!omp.ask) return;
      recall = await this.#openMemory(input, `retain-${randomUUID()}`, input.answer);
      const written = await writeOmpOverlay(providers.ompRunDir(input.ownerId), randomUUID(), {
        settings: {
          ...DEFAULT_OMP_SETTINGS,
          models: { default: resolveModel(undefined, input.owner.defaultModel, this.options.defaultModel) },
          memory: input.agentSettings?.memory ?? DEFAULT_OMP_SETTINGS.memory,
        },
        memoryDbPath: recall.path,
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
      await recall?.close();
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
      profile?: ProfileRef | null;
      projectId: string;
      threadId: string;
      turnId: string;
      workspace: string;
      agentSettings?: WorkspaceAgentSettings;
      trusted?: boolean;
    },
    /** What the bridge carries: OMP's tools (the workspace's bridge), `ucch_agent`, `show_widget`, in any mix. */
    offer: { omp: boolean; subagents: boolean; widgets?: boolean; messaging?: boolean; browser?: boolean | "entry" | "full" },
  ): Promise<(Pick<ProviderRunInput, "mcpConfigPath" | "codexMcp"> & { omp: boolean; dispose(): Promise<void> }) | null> {
    const options = this.options.ompBridge;
    const providers = this.options.providers;
    if (!options || !providers) return null;
    // OMP's tools need the key their calls bill; without one the bridge
    // can still carry `ucch_agent`.
    let openrouterKey: string | null = null;
    if (offer.omp) {
      try {
        openrouterKey = this.#decryptKey(input.owner.openrouterKeyEncrypted);
      } catch {
        openrouterKey = null;
      }
    }
    if (!openrouterKey && !offer.subagents && !offer.widgets && !offer.messaging && !offer.browser) return null;
    // A bridge for `ucch_agent` alone is offered to every Claude Code and
    // Codex turn, so a server without the bundle must not hand the CLI an
    // MCP server it cannot start.
    if (!openrouterKey && !(await stat(options.bin).then((file) => file.isFile(), () => false))) return null;
    const memory = input.agentSettings?.memory ?? DEFAULT_OMP_SETTINGS.memory;
    const disposers: (() => Promise<void> | void)[] = [];
    const dispose = async () => {
      for (const step of disposers.splice(0).reverse()) await step();
    };
    try {
      const recall = openrouterKey && memory.enabled ? await this.#openMemory(input, `bridge-${input.turnId}`, "") : null;
      if (recall) disposers.push(() => recall.close());
      const overlay = !openrouterKey ? null : await writeOmpOverlay(providers.ompRunDir(input.ownerId), `bridge-${input.turnId}`, {
        // Each call names a role (`@smol`, `@slow`); every role is the
        // account's OpenRouter model until the workspace picks its own.
        settings: {
          ...DEFAULT_OMP_SETTINGS,
          models: { default: resolveModel(undefined, input.owner.defaultModel, this.options.defaultModel) },
          memory,
        },
        // The project's bank, as its OMP turns have it (OM7.2).
        ...(recall ? { memoryDbPath: recall.path, memoryToolsOnly: true } : {}),
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
      if (overlay) disposers.push(() => overlay.dispose());
      const lease = options.leases.register({ ownerId: input.ownerId, threadId: input.threadId });
      disposers.push(() => lease.revoke());
      const server = bridgeServer({
        node: process.execPath,
        bridgeBin: options.bin,
        ompBin: options.ompBin,
        omp:
          overlay && openrouterKey
            ? { agentDir: providers.ompAgentDir(input.ownerId), overlay: overlay.path, openrouterKey }
            : null,
        subagents: offer.subagents,
        messaging: offer.messaging === true,
        widgets: offer.widgets === true,
        browser: offer.browser === true ? "full" : (offer.browser ?? false),
        worktree: input.workspace,
        schedulerSock: options.socket,
        token: lease.token,
        maxSeconds: options.maxSeconds,
        trusted: input.trusted === true,
        memory: Boolean(overlay) && memory.enabled,
      });
      const runDir = providers.cliRunDir(input.ownerId, provider, input.profile);
      if (provider === "codex") {
        const codex = await writeCodexBridge(runDir, input.turnId, server, options.maxSeconds, offer.subagents);
        disposers.push(() => codex.dispose());
        return { codexMcp: codex.mcp, omp: Boolean(overlay), dispose };
      }
      const config = await writeClaudeMcpConfig(runDir, input.turnId, server);
      disposers.push(() => config.dispose());
      return { mcpConfigPath: config.path, omp: Boolean(overlay), dispose };
    } catch (error) {
      await dispose().catch(this.onError);
      throw error;
    }
  }

  /**
   * An OMP turn's `ucch_agent` call: a subagent on whichever harness its
   * model routes to (`SubagentRunner`), its answer the tool's result. OMP
   * names the call, so its card goes under it with no matching.
   */
  async #hostSubagent(
    call: HostToolCall,
    signal: AbortSignal,
    input: { ownerId: string; threadId: string; turnId: string },
  ): Promise<HostToolResult> {
    const args = call.arguments;
    const task = typeof args.task === "string" ? args.task : "";
    if (!this.#subagents || !task.trim()) {
      return { content: this.#subagents ? "ucch_agent needs a task" : "this server does not run subagents", isError: true };
    }
    const outcome = await this.#subagents.spawn(
      input.threadId,
      input.ownerId,
      {
        description: typeof args.description === "string" && args.description.trim() ? args.description.trim().slice(0, 200) : "Subagent",
        task,
        background: args.background === true,
        ...(typeof args.model === "string" && args.model.trim() ? { model: args.model.trim() } : {}),
      },
      signal,
      { turnId: input.turnId, toolUseId: call.toolCallId },
    );
    return "text" in outcome
      ? { content: outcome.text || "(the subagent finished without a reply)", isError: false }
      : { content: `ucch_agent: ${outcome.error}`, isError: true };
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
      /** The browser tools were advertised: the registry must offer them too, or `runTool` cannot find them. */
      browser?: boolean;
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
        registry: { ...this.options.registry, browser: input.browser === true },
        ...(input.browser ? { browser: this.#browserFor(input.projectId, input.threadId, input.workspace) } : {}),
        executor: new HostExecutor(input.workspace, {
          heavyJobs: this.options.heavyJobs,
          wrapArgv: this.options.wrapArgv,
          pathPrefix: () => this.options.runtimePath?.(input.workspace) ?? null,
        }),
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
    return { content: outcome.content, isError: outcome.isError, ...(outcome.images?.length ? { images: outcome.images } : {}) };
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
    const asks = sinceCleared(history.map((row) => row.event))
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
      // A hidden phase: its answer is read by the next agent, not the reader.
      registry: { ...this.options.registry, widgets: false },
      contextLength,
      supportsImages: canSeeImages,
      searchModel: this.options.searchModel,
      maxIterations: this.options.maxIterations,
      executor: new HostExecutor(input.workspace, {
          heavyJobs: this.options.heavyJobs,
          wrapArgv: this.options.wrapArgv,
          pathPrefix: () => this.options.runtimePath?.(input.workspace) ?? null,
        }),
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
        // A subagent reports to its parent, not to the reader: no widgets.
        registry: { ...this.options.registry, widgets: false },
        contextLength,
        supportsImages: canSeeImages,
        searchModel: this.options.searchModel,
        maxIterations: this.options.maxIterations,
        executor: new HostExecutor(workspace, {
          heavyJobs: this.options.heavyJobs,
          wrapArgv: this.options.wrapArgv,
          pathPrefix: () => this.options.runtimePath?.(workspace) ?? null,
        }),
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
   * A turn of the Terminal section's agent, which works on an SSH host
   * rather than in a project: the caller brings the executor, the tools,
   * the prompt, the gate and where the events go.
   *
   * Billed like a native turn in the workspace -- the person's own key, or
   * the workspace's under a workspace credential policy -- on the model they
   * picked or their default, and it takes a native turn's slot.
   */
  async runRemoteTurn(input: {
    userId: string;
    workspaceId: string;
    chatId: string;
    turnId: string;
    model?: string;
    history: readonly DomainEvent[];
    executor: Executor;
    systemPrompt: string;
    toolset: readonly string[];
    approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
    append: (events: readonly DomainEvent[]) => Promise<void>;
    publish: (event: DomainEvent) => void;
    signal: AbortSignal;
  }): Promise<{ text: string; model: string; usage: TokenUsage; costUsd: number }> {
    const [person] = await this.db
      .select({
        id: users.id,
        openrouterKeyEncrypted: accountOpenRouterKey,
        defaultModel: users.defaultModel,
        defaultProvider: users.defaultProvider,
        agentPermissionMode: users.agentPermissionMode,
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    if (!person) throw new Error("account not found");
    const [workspace] = await this.db
      .select({ policy: workspaces.credentialPolicy, workspaceKey: workspaces.openrouterKeyEncrypted })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    let owner: TurnOwner = { ...person, personId: person.id };
    if (workspace && effectiveCredentialSource(toPolicy(workspace.policy), null) === "workspace") {
      owner = { ...owner, id: workspaceSubject(input.workspaceId), openrouterKeyEncrypted: workspace.workspaceKey };
    }
    const requested = resolveModel(input.model, owner.defaultModel, this.options.defaultModel);
    const route = await this.#nativeRoute(owner, requested);
    const [contextLength, canSeeImages] = await Promise.all([route.contextLength(), route.supportsImages()]);

    const release = await this.#scheduler.acquire({
      ownerId: owner.id,
      kind: "native",
      threadId: input.chatId,
      signal: input.signal,
    });
    try {
      const outcome = await runTurn({
        projectId: REMOTE_CHAT_PROJECT_ID,
        threadId: input.chatId,
        turnId: input.turnId,
        apiKey: route.apiKey,
        model: route.model,
        history: input.history,
        stack: null,
        preset: "minimal",
        registry: { ...this.options.registry, widgets: false },
        toolset: input.toolset,
        systemPrompt: input.systemPrompt,
        contextLength,
        supportsImages: canSeeImages,
        searchModel: this.options.searchModel,
        maxIterations: this.options.maxIterations,
        executor: input.executor,
        complete: route.complete,
        signal: input.signal,
        approve: input.approve,
        append: input.append,
        publish: input.publish,
        onDiagnostic: (message) => this.onError(new Error(message)),
      });
      return { text: outcome.text, model: requested, usage: outcome.usage, costUsd: outcome.costUsd };
    } finally {
      release();
    }
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
        // The default named OpenRouter key, else the account's own.
        openrouterKeyEncrypted: accountOpenRouterKey,
        defaultModel: users.defaultModel,
        defaultProvider: users.defaultProvider,
        agentPermissionMode: users.agentPermissionMode,
      })
      .from(users)
      .where(eq(users.id, personId))
      .limit(1);
    if (!person) return null;
    const owner = { ...person, personId: person.id };

    const bound = thread?.credentialSource === "workspace" || thread?.credentialSource === "member"
      ? thread.credentialSource
      : null;
    if (effectiveCredentialSource(toPolicy(project.policy), bound) === "workspace") {
      return {
        ...owner,
        id: workspaceSubject(project.workspaceId),
        openrouterKeyEncrypted: project.workspaceKey,
      };
    }
    return owner;
  }

  /**
   * The subscription account a Claude Code or Codex turn signs in as.
   * Narrowest first: the one the session was bound to, then the person's
   * default for the project, then the subject's Default account -- each
   * only if it is the subject's own and the provider's. Null for OMP and
   * when the server keeps no accounts.
   *
   * A project that asks for `work` (or `personal`) accounts refuses any
   * other: the turn fails saying so, rather than quietly billing the
   * wrong subscription.
   */
  async #profileFor(
    projectId: string,
    owner: TurnOwner,
    boundProfileId: string | null | undefined,
    provider: CliProviderId,
  ): Promise<AgentProfile | null> {
    const profiles = this.options.profiles;
    if (!profiles || (provider !== "claude" && provider !== "codex")) return null;
    const usable = (row: AgentProfile | null) => (row && row.provider === provider ? row : null);
    let row = boundProfileId ? usable(await profiles.owned(boundProfileId, owner.id)) : null;
    if (!row) {
      const chosen = await profiles.projectDefault(projectId, owner.personId, provider);
      row = chosen ? usable(await profiles.owned(chosen, owner.id)) : null;
    }
    row ??= await profiles.defaultFor(owner.id, provider);
    const [project] = await this.db
      .select({ requiredContext: projects.requiredContext })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const required = project?.requiredContext ?? null;
    if (!contextAllowed(required, row.context)) {
      throw new Error(
        `This project runs only on ${required} accounts, and the ${harnessLabel(provider)} account "${row.label}" is tagged ${row.context}. ` +
          `Pick a ${required} account from the session header, or change the account's tag in Settings -> Harness.`,
      );
    }
    return row;
  }

  /**
   * Where a native turn's calls go, and on what key.
   *
   * A plain model id is the default OpenRouter key's, as it always was. One
   * of the form `@<keyId>/<model>` names one of the person's own named keys:
   * that key, its provider's base URL, and the bare model id. The turn's
   * side calls on other models -- the search model, compaction -- are
   * OpenRouter models; on an AnonRouter key they go to OpenRouter on the
   * default key when there is one.
   */
  async #nativeRoute(
    owner: TurnOwner,
    model: string,
  ): Promise<{
    apiKey: string;
    model: string;
    complete: Complete;
    contextLength: () => Promise<number | null>;
    supportsImages: () => Promise<boolean>;
  }> {
    const keyed = parseKeyedModel(model);
    if (!keyed) {
      return {
        apiKey: this.#decryptKey(owner.openrouterKeyEncrypted),
        model,
        complete: streamCompletion,
        contextLength: () => contextLengthFor(model),
        supportsImages: () => supportsImages(model),
      };
    }
    if (!this.options.secretKey) {
      throw new Error("SECRET_KEY is not configured, so no stored key can be decrypted");
    }
    const stored = await this.options.modelKeys?.use(owner.personId, keyed.keyId);
    if (!stored) {
      throw new Error("The API key this model was picked under no longer exists. Pick a model under another key in the composer.");
    }
    const inner = keyed.model;
    if (stored.kind === "openrouter") {
      return {
        apiKey: stored.key,
        model: inner,
        complete: streamCompletion,
        contextLength: () => contextLengthFor(inner),
        supportsImages: () => supportsImages(inner),
      };
    }
    const baseUrl = baseUrlFor(stored.kind);
    let fallbackKey: string | null = null;
    try {
      fallbackKey = owner.openrouterKeyEncrypted ? this.#decryptKey(owner.openrouterKeyEncrypted) : null;
    } catch {
      fallbackKey = null;
    }
    const complete: Complete = (request, onDelta) =>
      request.model === inner || !fallbackKey
        ? streamCompletion({ ...request, apiKey: stored.key }, onDelta, { baseUrl }).catch((error: unknown) => {
            throw error instanceof Error
              ? new Error(error.message.replace(/^openrouter:/, `${stored.kind}:`))
              : error;
          })
        : streamCompletion({ ...request, apiKey: fallbackKey }, onDelta);
    const entry = async () => (await anonCatalogue().catch(() => [])).find((m) => m.id === inner);
    return {
      apiKey: stored.key,
      model: inner,
      complete,
      contextLength: async () => (await entry())?.contextLength ?? null,
      supportsImages: async () => (await entry())?.images ?? false,
    };
  }

  /** The stored key in the clear, for exactly this turn. */
  #decryptKey(encrypted: string | null): string {
    if (!this.options.secretKey) {
      throw new Error("SECRET_KEY is not configured, so no stored key can be decrypted");
    }
    if (!encrypted) {
      throw new Error("No OpenRouter API key is set. Add one in Settings -- or, when this workspace uses its own subscription, in Workspace settings -> Harness -- to talk to the agent.");
    }
    const key = decryptSecret(encrypted, this.options.secretKey);
    this.options.onKeyUsed?.(encrypted);
    return key;
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
/** The workspace's "Allow interactive widgets"; on when it has no say. */
export function widgetsOn(settings: WorkspaceAgentSettings | undefined | null): boolean {
  return settings?.widgets?.enabled !== false;
}

export function claudePromptNeedsPerson(mode: AgentPermissionMode, toolName: string, input: unknown): boolean {
  // Draws a widget in the chat and does nothing else: never worth asking about.
  if (toolName === ompBridgeToolName(SHOW_WIDGET_TOOL)) return false;
  // The shared browser asks as a native turn's browser tools do: by what each one is.
  const browserOp = toolName.startsWith(ompBridgeToolName("browser_")) ? toolName.slice(ompBridgeToolName("").length) : null;
  if (browserOp && isBrowserOp(browserOp)) return needsApproval(mode, { kind: browserSpec(browserOp).permission });
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

/** The shell line a call runs, when it is one: `bash`'s and `Bash`'s `command`. */
function shellCommandOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

/** An event as one made between turns: the turn it was streamed under never opened. */
function withoutTurn(event: DomainEvent): DomainEvent {
  if (!("turnId" in event)) return event;
  const { turnId: _turnId, ...rest } = event as DomainEvent & { turnId?: string };
  return rest as DomainEvent;
}

/**
 * Whether a thread's log has a question still open: a permission prompt
 * or a choice card nobody answered. A new turn overtakes both; a finished
 * one leaves no permission prompt open.
 */
export function openRequests(events: readonly DomainEvent[]): boolean {
  const open = new Set<string>();
  for (const event of events) {
    if (event.type === "agent.permission_requested" || event.type === "agent.choice_requested") open.add(event.requestId);
    else if (event.type === "agent.permission_resolved" || event.type === "agent.choice_resolved") open.delete(event.requestId);
    else if (event.type === "turn.started") open.clear();
    else if (event.type === "agent.turn_completed" || event.type === "agent.turn_failed") {
      for (const prior of events) if (prior.type === "agent.permission_requested") open.delete(prior.requestId);
    }
  }
  return open.size > 0;
}

/** Whether nothing was said since the session was last compacted: another compaction would fold nothing. */
export function lastWasCompaction(events: readonly DomainEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === "user.message" || event.type === "turn.started") return false;
    if (event.type === "thread.compaction_finished") return !event.error;
  }
  return false;
}

/**
 * The events after the thread's last `thread.context_cleared`: what its
 * agent can still see. Everything, when it was never cleared.
 */
export function sinceCleared<E extends { type: string }>(events: readonly E[]): E[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === "thread.context_cleared") return events.slice(i + 1);
  }
  return [...events];
}

/**
 * The newest plan an agent proposed on a thread (`<proposed_plan>`), from
 * the text its turns streamed, newest turn first.
 */
export function latestProposedPlan(events: readonly DomainEvent[]): string | null {
  const texts = new Map<string, string>();
  for (const event of events) {
    if (event.type === "agent.text_delta") texts.set(event.turnId, (texts.get(event.turnId) ?? "") + event.text);
  }
  for (const text of [...texts.values()].reverse()) {
    const plan = proposedPlanIn(text);
    if (plan) return plan;
  }
  return null;
}
