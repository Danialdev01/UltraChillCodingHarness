import { isAbsolute, join, relative } from "node:path";
import {
  normalizeWorkspacePath,
  type AgentPermissionMode,
  type DomainEvent,
  type ReasoningEffort,
  type TokenUsage,
} from "@ucch/protocol";
import type { ExitStatus } from "./process.js";
import { exitedBySignal, runCli, type Normaliser } from "./run.js";
import type {
  AgentProvider,
  AgentRun,
  PermissionReply,
  ProviderHealth,
  ProviderRunInput,
  RunContext,
} from "./types.js";
import { forbiddenEnvPresent } from "./types.js";

/**
 * Claude Code as a provider: `claude -p` with the JSONL stream on stdout.
 *
 * Two flags are load-bearing and easy to get wrong later, so they are
 * spelled out here rather than left to the argv builder to explain:
 *
 * **Never pass `--bare`.** It is the documented recommendation for scripted
 * calls, and it explicitly does not read OAuth credentials, the keychain or
 * `CLAUDE_CODE_OAUTH_TOKEN`. It is exactly wrong for subscription auth: add
 * it for startup speed and every run fails with an authentication error.
 * `claudeArgv` has a test that fails if it ever appears.
 *
 * **`ANTHROPIC_API_KEY` must be absent.** Auth precedence puts it above the
 * subscription login, and in `-p` mode a key is used without a prompt. The
 * server builds the environment and `runCli` refuses one that carries it.
 */

/** Models the composer offers. Aliases: the CLI resolves them to a version. */
/** What `--effort` accepts. Every model on the list takes every level. */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const CLAUDE_MODELS = [
  { id: "sonnet", name: "Claude Sonnet", efforts: CLAUDE_EFFORTS },
  { id: "opus", name: "Claude Opus", efforts: CLAUDE_EFFORTS },
  { id: "haiku", name: "Claude Haiku", efforts: CLAUDE_EFFORTS },
] as const;

/** Flags that exist only from certain CLI versions on. Detected, not assumed. */
export interface ClaudeCapabilities {
  permissionPrompts: boolean;
  settingSources: boolean;
  /** `--mcp-config` with `--strict-mcp-config`: what the OMP bridge is offered through. */
  mcpConfig: boolean;
}

/**
 * The bridge's tools that run unasked under Normal (solution §10.3): the
 * ones that only read, as Claude Code's own reads do, and `ucch_agent`,
 * which starts a subagent as Claude Code's own `Agent` tool does. The rest
 * -- a rename, a codemod, a debugging session, a memory write, a handoff
 * brief -- ask, as a command does; under Strict everything asks, and after
 * "Allow All" nothing does.
 */
export const OMP_BRIDGE_READ_TOOLS = ["omp_symbols", "omp_recall", "omp_review", "omp_task", "ucch_agent", "ucch_sessions", "ucch_inbox", "ucch_message", "ucch_agent_status", "ucch_agent_cancel", "show_widget"] as const;

/**
 * How long Claude Code waits on one MCP tool call (`MCP_TOOL_TIMEOUT`, ms):
 * a `ucch_agent` subagent runs a whole turn on another harness, which can
 * take far longer than the CLI's default allows.
 */
export const MCP_TOOL_TIMEOUT_MS = 60 * 60 * 1000;

/** How Claude Code names an MCP server's tool: `mcp__<server>__<tool>`. */
export const ompBridgeToolName = (tool: string) => `mcp__omp__${tool}`;

export function claudeArgv(input: {
  bin: string;
  model?: string;
  /** `off` is no flag at all: the CLI picks the model's default. */
  effort?: ReasoningEffort;
  resumeToken?: string;
  caps: ClaudeCapabilities;
  /**
   * The account's agent permission mode. Strict starts the CLI in `default`,
   * where edits ask too; the others in `acceptEdits`, and the harness
   * answers the prompts its mode does not need a person for.
   */
  permissionMode?: AgentPermissionMode;
  /**
   * Added to the CLI's system prompt. Sent on resumed turns too: `-p` keeps
   * the conversation across `--resume`, not the flags it was started with.
   */
  appendSystemPrompt?: string;
  /**
   * The turn's MCP config, offering the OMP bridge (solution §10.3). Only
   * UCCH's servers load (`--strict-mcp-config`), as only the user's
   * settings do. Absent, or a CLI without the flags: no MCP config at all.
   */
  mcpConfigPath?: string;
}): string[] {
  const argv = [
    input.bin,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // The prompt goes in as a JSON line and stdin stays open: that is the
    // channel the CLI's permission prompts come back on.
    "--input-format",
    "stream-json",
    // `-p` starts at manual on every plan, so a mode must be named. Edits in
    // the workspace are the point; nothing here ever ships bypassPermissions.
    "--permission-mode",
    input.permissionMode === "strict" ? "default" : "acceptEdits",
    // Anything acceptEdits does not cover -- a shell command, a fetch -- is
    // asked over stdio as a `control_request`, and the person answers it
    // from the chat. Without this the CLI denies it on its own and the
    // model is left explaining that it could not run `npm install`.
    "--permission-prompt-tool",
    "stdio",
  ];
  // Newer CLIs default prompts to the host; named so a future default
  // cannot quietly turn into "none" and stall or deny behind our back.
  if (input.caps.permissionPrompts) argv.push("--permission-prompts", "host");
  // The user's settings only. A cloned repository's `.claude/settings.json`
  // -- its hooks, its MCP servers -- is model-visible instruction from
  // whoever wrote the repository, and this is a harness that clones anything.
  if (input.caps.settingSources) argv.push("--setting-sources", "user");
  if (input.mcpConfigPath && input.caps.mcpConfig) {
    argv.push("--mcp-config", input.mcpConfigPath, "--strict-mcp-config");
    // Normal is the default mode (`DEFAULT_AGENT_PERMISSION_MODE`).
    if ((input.permissionMode ?? "normal") === "normal") {
      argv.push("--allowedTools", ...OMP_BRIDGE_READ_TOOLS.map(ompBridgeToolName));
    }
  }
  if (input.model) argv.push("--model", input.model);
  if (input.effort && input.effort !== "off") argv.push("--effort", input.effort);
  if (input.resumeToken) argv.push("--resume", input.resumeToken);
  if (input.appendSystemPrompt) argv.push("--append-system-prompt", input.appendSystemPrompt);
  return argv;
}

/** `d***@example.com`: enough to recognise, not enough to leak. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/** What `claude auth status` prints. Anything missing reads as logged out. */
interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  email?: string;
  subscriptionType?: string;
}

export async function probeClaude(
  ctx: RunContext,
  bin: string,
): Promise<ProviderHealth & { caps: ClaudeCapabilities }> {
  const caps: ClaudeCapabilities = { permissionPrompts: false, settingSources: false, mcpConfig: false };
  const forbidden = forbiddenEnvPresent(ctx.env);
  const warnings = forbidden
    ? [`${forbidden} is set in the provider environment; runs would bill an API key.`]
    : [];

  const base = (over: Partial<ProviderHealth>): ProviderHealth & { caps: ClaudeCapabilities } => ({
    installed: false,
    authenticated: false,
    authMode: "none",
    ...(warnings.length ? { warnings } : {}),
    ...over,
    caps,
  });

  const spec = (argv: string[]) => ({ argv: [bin, ...argv], cwd: ctx.cwd, env: ctx.env });
  const version = await ctx.host.run(spec(["--version"]), { timeoutMs: 15_000 }).catch(() => null);
  if (!version || version.code !== 0) {
    return base({ error: version?.stderr.trim() || "claude is not installed" });
  }

  const help = await ctx.host.run(spec(["-p", "--help"]), { timeoutMs: 15_000 }).catch(() => null);
  const helpText = help?.stdout ?? "";
  caps.permissionPrompts = helpText.includes("--permission-prompts");
  caps.settingSources = helpText.includes("--setting-sources");
  caps.mcpConfig = helpText.includes("--strict-mcp-config");

  const status = await ctx.host
    .run(spec(["auth", "status"]), { timeoutMs: 15_000 })
    .catch(() => null);
  let auth: AuthStatus = {};
  try {
    auth = JSON.parse(status?.stdout ?? "{}") as AuthStatus;
  } catch {
    /* an older CLI prints prose; treat as logged out */
  }

  const loggedIn = auth.loggedIn === true;
  const tokenMode = "CLAUDE_CODE_OAUTH_TOKEN" in ctx.env;
  const authMode: ProviderHealth["authMode"] = !loggedIn
    ? "none"
    : auth.authMethod === "claude.ai" || auth.authMethod === "oauth"
      ? tokenMode
        ? "token"
        : "subscription"
      : "api-key";

  return base({
    installed: true,
    version: version.stdout.trim().split(/\s+/)[0],
    authenticated: loggedIn,
    authMode,
    ...(auth.email ? { account: maskEmail(auth.email) } : {}),
    ...(status && status.code !== 0 && !loggedIn && status.stderr.trim()
      ? { error: status.stderr.trim() }
      : {}),
  });
}

/** The tools that spawn a subagent: `Task`, renamed `Agent` by 2.1.316. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** At most one progress line a second per subagent (solution §6.2). */
const SUBAGENT_PROGRESS_MS = 1_000;

/** The size a subagent's result is held to on its card. */
const SUBAGENT_RESULT_CHARS = 8_000;

/** A block a subagent wrote, longer than the event allows, ends where it is cut. */
const SUBAGENT_OUTPUT_CHARS = 20_000;

/** `agent.subagent_output`: one of a subagent's blocks, for its own page. */
function subagentOutput(
  ids: { threadId: string; turnId: string },
  subagentId: string,
  kind: "text" | "thinking",
  text: string,
): DomainEvent {
  const trimmed = text.trim();
  return {
    type: "agent.subagent_output",
    ...ids,
    subagentId,
    kind,
    text: trimmed.length > SUBAGENT_OUTPUT_CHARS ? `${trimmed.slice(0, SUBAGENT_OUTPUT_CHARS - 14)}\n[… truncated]` : trimmed,
  };
}

interface ClaudeSubagent {
  /** Registered in the background: its call's tool_result is only the launch. */
  background: boolean;
  toolCalls: number;
  durationMs?: number;
  lastProgressAt: number;
  /** Its latest prose: the result when the CLI's own is a summary. */
  lastText: string | null;
}

/** Tools whose successful result means a file in the workspace changed. */
const WRITING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

interface PendingCall {
  startedAt: number;
  name: string;
  path: string | null;
}

/** A content block as the CLI prints it. Only the fields read here. */
interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  /** A `thinking` block's text. */
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Line {
  type?: string;
  subtype?: string;
  session_id?: string;
  request_id?: string;
  request?: {
    subtype?: string;
    tool_name?: string;
    input?: unknown;
    description?: string;
    tool_use_id?: string;
  };
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: { id?: string; content?: Block[] };
  tool_use_result?: { type?: string };
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error?: unknown;
  rate_limit_info?: { status?: string; rateLimitType?: string; resetsAt?: number };
  /** The API's own error type, on a response it refused: `usage_limit_reached` for the plan's limit. */
  api_error?: string;
  /** `system` `task_*` lines: a background task's id, its spawning call, and how it is going. */
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
  task_type?: string;
  status?: string;
  summary?: string;
  last_tool_name?: string;
  is_error?: boolean;
  result?: string | null;
  terminal_reason?: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
  /** `system` `background_tasks_changed`: every background task still running. */
  tasks?: { task_id?: string }[];
}

/**
 * Turns Claude Code's stream into the harness's events.
 *
 * The CLI emits one `assistant` line per content block, all sharing a
 * message id, so the durable `agent.message` for a response is assembled
 * across lines and written when the id changes or the turn ends -- the
 * chat rebuilds prose from it after a reload, and a message per block
 * would show one line of a paragraph as three messages.
 */
export class ClaudeNormaliser implements Normaliser {
  #sessionId: string | null = null;
  #closed = false;
  #interrupted = false;
  #pending = new Map<string, PendingCall>();
  /** Permission prompts raised and not yet answered, with the input each gates. */
  #prompts = new Map<string, unknown>();
  #io: { write(line: string): void; endStdin(): void } | null = null;
  /** The response being assembled: blocks so far, keyed by message id. */
  #message: { id: string; content: unknown[] } | null = null;
  /** The turn met a usage limit: a refused `rate_limit_event`, or a response the API refused for one. */
  #limited = false;
  /** This turn's `Agent` / `Task` calls, by tool use id: what each subagent was asked. */
  #agentCalls = new Map<string, { agent: string | null; description: string | null }>();
  /** Subagents started and not yet finished, by the spawning call's id (solution §6.2). */
  #subagents = new Map<string, ClaudeSubagent>();
  /** Finished ones, so a late line does not start them again. */
  #finishedSubagents = new Set<string>();
  /**
   * Background tasks still running, by task id, as the CLI's
   * `background_tasks_changed` lists them. While any is, a `result` is not
   * the end of the turn: the CLI goes on, wakes the model when they finish,
   * and prints another `result` then.
   */
  #backgroundTasks = new Set<string>();
  /** A `result` held back for the background tasks, with its cost so far. */
  #heldResult: { costUsd: number } | null = null;
  #usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };

  constructor(
    private readonly ctx: {
      projectId: string;
      threadId: string;
      turnId: string;
      workspace: string;
      now?: () => number;
    },
  ) {}

  get sessionId(): string | null {
    return this.#sessionId;
  }

  noteInterrupt(): void {
    this.#interrupted = true;
  }

  bind(io: { write(line: string): void; endStdin(): void }): void {
    this.#io = io;
  }

  /**
   * Answers a prompt on the CLI's stdin, in the shape its `control_response`
   * expects. An allow echoes the input back unchanged: the CLI treats the
   * echoed input as authoritative, and the person approved what they saw.
   */
  answerPermission(requestId: string, reply: PermissionReply): DomainEvent[] {
    if (!this.#prompts.has(requestId) || !this.#io) return [];
    const input = this.#prompts.get(requestId);
    this.#prompts.delete(requestId);
    const response =
      reply.behavior === "allow"
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: reply.message?.trim() || "The user declined this action." };
    this.#io.write(
      JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response },
      }),
    );
    return [
      {
        type: "agent.permission_resolved",
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        requestId,
        behavior: reply.behavior,
      },
    ];
  }

  push(raw: string): DomainEvent[] {
    // After the turn's end nothing more is the turn's: a stray line must not
    // end it twice.
    if (this.#closed || !raw.trim().startsWith("{")) return [];
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      return [];
    }
    const ids = { threadId: this.ctx.threadId, turnId: this.ctx.turnId };

    switch (line.type) {
      case "system": {
        if (line.subtype === "init" && line.session_id) {
          // A model woken by a finished background task starts with another
          // init for the same session: one session, one announcement.
          if (this.#sessionId === line.session_id) return [];
          this.#sessionId = line.session_id;
          return [
            {
              type: "agent.session_started",
              ...ids,
              provider: "claude",
              sessionId: line.session_id,
            },
          ];
        }
        // A subagent's own task lines (2.1.316): `Agent` calls run in the
        // background, so these, not the call's tool_result, say how it went.
        if (line.subtype === "task_started" || line.subtype === "task_progress" || line.subtype === "task_notification") {
          return this.#taskLine(line);
        }
        if (line.subtype === "background_tasks_changed" && Array.isArray(line.tasks)) {
          this.#backgroundTasks = new Set(line.tasks.map((task) => task.task_id).filter((id): id is string => !!id));
          return [];
        }
        if (line.subtype === "api_retry") {
          return [
            {
              type: "agent.retry",
              ...ids,
              attempt: line.attempt ?? 0,
              maxRetries: line.max_retries ?? 0,
              delayMs: line.retry_delay_ms ?? 0,
              category: describeError(line.error),
            },
          ];
        }
        return [];
      }

      case "rate_limit_event":
        // `allowed`, `allowed_warning` or `rejected` (2.1.316's SDK schema);
        // only a refusal says this turn met the limit.
        if (line.rate_limit_info?.status === "rejected") this.#limited = true;
        return [];

      case "stream_event": {
        // Subagent prose is not this turn's prose; its lines arrive whole
        // as assistant lines below, and become its progress.
        if (line.parent_tool_use_id) return [];
        const delta = line.event?.delta;
        if (line.event?.type !== "content_block_delta" || !delta) return [];
        if (delta.type === "text_delta" && delta.text) {
          return [{ type: "agent.text_delta", ...ids, text: delta.text }];
        }
        if (delta.type === "thinking_delta" && delta.thinking) {
          return [{ type: "agent.thinking_delta", ...ids, text: delta.thinking }];
        }
        return [];
      }

      case "assistant": {
        // An API error the CLI wrote as the response. The plan's limit is
        // `api_error: "usage_limit_reached"` (beside `error: "rate_limit"`),
        // or `billing_error` ("usage limit reached -- check plan"). A bare
        // `rate_limit` is a request throttled past its retries, which the
        // plan's next reset has nothing to do with.
        if (!line.parent_tool_use_id && isLimitLine(line)) this.#limited = true;
        if (line.parent_tool_use_id) return this.#subagentLine(line.parent_tool_use_id, line.message?.content ?? []);
        const blocks = line.message?.content ?? [];
        const events: DomainEvent[] = [];
        const id = line.message?.id ?? "";
        if (this.#message && this.#message.id !== id) events.push(...this.#flushMessage());
        if (!this.#message) this.#message = { id, content: [] };
        for (const block of blocks) {
          this.#message.content.push(block);
          if (block.type !== "tool_use" || !block.id) continue;
          this.#pending.set(block.id, {
            startedAt: this.#now(),
            name: block.name ?? "tool",
            path: this.#pathOf(block),
          });
          if (SUBAGENT_TOOLS.has(block.name ?? "")) {
            const input = (block.input ?? {}) as { subagent_type?: unknown; description?: unknown };
            this.#agentCalls.set(block.id, {
              agent: typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : null,
              description: typeof input.description === "string" && input.description ? input.description : null,
            });
          }
          // Written as the model asked for it, before the result: the same
          // order the native loop keeps.
          events.push(...this.#flushMessage());
          events.push({
            type: "agent.tool_use",
            ...ids,
            toolUseId: block.id,
            name: block.name ?? "tool",
            input: block.input ?? null,
          });
        }
        return events;
      }

      case "user": {
        const events: DomainEvent[] = [];
        for (const block of line.message?.content ?? []) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const call = this.#pending.get(block.tool_use_id);
          this.#pending.delete(block.tool_use_id);
          const isError = block.is_error === true;
          events.push({
            type: "agent.tool_result",
            ...ids,
            toolUseId: block.tool_use_id,
            content: flattenContent(block.content),
            isError,
            durationMs: call ? Math.max(0, this.#now() - call.startedAt) : 0,
          });
          if (call?.path && !isError) {
            events.push({
              type: "file.changed",
              projectId: this.ctx.projectId,
              path: call.path,
              change: call.name === "Write" && line.tool_use_result?.type === "create"
                ? "added"
                : "modified",
            });
          }
          // A foreground subagent's result is its call's; a background one's
          // call only says it was launched, and `task_notification` ends it.
          const subagent = this.#subagents.get(block.tool_use_id);
          const content = flattenContent(block.content);
          if (subagent && !subagent.background && !content.startsWith("Async agent launched")) {
            events.push(...this.#subagentFinished(block.tool_use_id, isError ? "failed" : "completed", content));
          } else if (!subagent && this.#agentCalls.has(block.tool_use_id) && !content.startsWith("Async agent launched")) {
            events.push(...this.#subagentStarted(block.tool_use_id, {}));
            events.push(...this.#subagentFinished(block.tool_use_id, isError ? "failed" : "completed", content));
          }
        }
        return events;
      }

      case "control_request": {
        if (line.request?.subtype !== "can_use_tool" || !line.request_id) return [];
        // Hold the prose so far: the prompt refers to the call just made,
        // and the chat should show that call before the question about it.
        const events = this.#flushMessage();
        this.#prompts.set(line.request_id, line.request.input ?? null);
        events.push({
          type: "agent.permission_requested",
          ...ids,
          requestId: line.request_id,
          toolUseId: line.request.tool_use_id ?? null,
          toolName: line.request.tool_name ?? "tool",
          input: line.request.input ?? null,
          description: line.request.description ?? null,
        });
        return events;
      }

      case "result": {
        // Background tasks still running: the model ended its reply, not the
        // turn. Holding stdin open keeps their permission prompts answerable
        // (closed, every one fails with "Stream closed"), and the turn ends
        // on the `result` that follows them.
        if (!line.is_error && !this.#interrupted && this.#backgroundTasks.size > 0) {
          const events = this.#flushMessage();
          this.#usage = addUsage(this.#usage, mapUsage(line.usage));
          this.#heldResult = { costUsd: Math.max(0, line.total_cost_usd ?? 0) };
          if (line.session_id) this.#sessionId = line.session_id;
          return events;
        }
        this.#closed = true;
        const events = this.#flushMessage();
        events.push(...this.#closePrompts());
        events.push(...this.#closeSubagents());
        // With stdin held for prompts the CLI waits for the next message
        // after a result; closing it is what lets the process exit.
        this.#io?.endStdin();
        if (line.session_id) this.#sessionId = line.session_id;
        // A turn that waited on background tasks spans several results; the
        // CLI's cost is already a running total, its usage is per result.
        this.#usage = this.#heldResult ? addUsage(this.#usage, mapUsage(line.usage)) : mapUsage(line.usage);
        this.#heldResult = null;
        // SIGINT gets a result line too, marked as an error with
        // `terminal_reason: "aborted_streaming"`. That is the stop button
        // working, not a failure, and the thread must come back idle.
        const aborted = this.#interrupted || line.terminal_reason?.startsWith("aborted") === true;
        if (line.is_error && aborted) {
          events.push({
            type: "agent.turn_completed",
            ...ids,
            stopReason: "cancelled",
            usage: this.#usage,
            costUsd: Math.max(0, line.total_cost_usd ?? 0),
          });
        } else if (line.is_error) {
          const error = line.result?.trim() || line.subtype || "claude reported an error";
          events.push({
            type: "agent.turn_failed",
            ...ids,
            error: explainClaudeError(error),
            ...(this.#limited || isLimitLine(line) || isClaudeLimit(error) ? { limit: true as const } : {}),
          });
        } else {
          events.push({
            type: "agent.turn_completed",
            ...ids,
            stopReason: line.subtype === "success" ? "end_turn" : (line.subtype ?? null),
            usage: this.#usage,
            costUsd: Math.max(0, line.total_cost_usd ?? 0),
          });
        }
        return events;
      }

      default:
        // `rate_limit_event`, `system/status`, `system/permission_denied`
        // and whatever next week's release adds. Unknown is ignored, never
        // fatal.
        return [];
    }
  }

  finish(exit: ExitStatus & { interrupted: boolean; stderrTail: string }): DomainEvent[] {
    if (this.#closed) return [];
    this.#closed = true;
    const ids = { threadId: this.ctx.threadId, turnId: this.ctx.turnId };
    const events = this.#flushMessage();
    events.push(...this.#closePrompts());
    // It answered, then waited on background tasks and exited cleanly
    // without a second result: the answer stands.
    if (this.#heldResult && !exit.interrupted && exit.code === 0) {
      events.push(...this.#closeSubagents("aborted"));
      events.push({
        type: "agent.turn_completed",
        ...ids,
        stopReason: "end_turn",
        usage: this.#usage,
        costUsd: this.#heldResult.costUsd,
      });
      return events;
    }
    events.push(...this.#closeSubagents(exit.interrupted ? "aborted" : "failed"));
    if (exit.interrupted && (exitedBySignal(exit) || exit.code === 0)) {
      events.push({
        type: "agent.turn_completed",
        ...ids,
        stopReason: "cancelled",
        usage: this.#usage,
        costUsd: 0,
      });
      return events;
    }
    const why = exit.stderrTail || (exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`);
    events.push({
      type: "agent.turn_failed",
      ...ids,
      error: explainClaudeError(`claude exited with ${why}`),
      ...(this.#limited || isClaudeLimit(why) ? { limit: true as const } : {}),
    });
    return events;
  }

  #now(): number {
    return (this.ctx.now ?? Date.now)();
  }

  /** A turn that ends with prompts open answers them: nobody else will. */
  #closePrompts(): DomainEvent[] {
    const events: DomainEvent[] = [];
    for (const requestId of this.#prompts.keys()) {
      events.push({
        type: "agent.permission_resolved",
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        requestId,
        behavior: "deny",
      });
    }
    this.#prompts.clear();
    return events;
  }

  /**
   * A line from inside a subagent (`parent_tool_use_id` set). Its prose is
   * not this turn's: it becomes the subagent's progress line, never a delta
   * or part of the turn's message. Its tool calls are still the turn's tool
   * events -- they act on the same worktree, and revert and the file view
   * follow them -- and also its progress.
   */
  #subagentLine(parent: string, blocks: Block[]): DomainEvent[] {
    const ids = { threadId: this.ctx.threadId, turnId: this.ctx.turnId };
    const events = this.#subagentStarted(parent, {});
    const subagent = this.#subagents.get(parent);
    for (const block of blocks) {
      if (block.type === "text" && block.text?.trim()) {
        if (subagent) subagent.lastText = block.text.trim();
        events.push(subagentOutput(ids, parent, "text", block.text));
        events.push(...this.#subagentProgress(parent, block.text));
      } else if (block.type === "thinking" && block.thinking?.trim()) {
        events.push(subagentOutput(ids, parent, "thinking", block.thinking));
      } else if (block.type === "tool_use" && block.id) {
        this.#pending.set(block.id, { startedAt: this.#now(), name: block.name ?? "tool", path: this.#pathOf(block) });
        events.push({
          type: "agent.tool_use",
          ...ids,
          toolUseId: block.id,
          name: block.name ?? "tool",
          input: block.input ?? null,
          subagentId: parent,
        });
        if (subagent) subagent.toolCalls += 1;
        events.push(...this.#subagentProgress(parent, block.name ?? "tool"));
      }
    }
    return events;
  }

  /** `task_started` / `task_progress` / `task_notification`, for a subagent this turn spawned. */
  #taskLine(line: Line): DomainEvent[] {
    const parent = line.tool_use_id;
    if (!parent || (!this.#agentCalls.has(parent) && line.task_type !== "local_agent")) return [];
    const usage = (line.usage ?? {}) as { tool_uses?: unknown; duration_ms?: unknown };
    const events = this.#subagentStarted(parent, {
      ...(line.subagent_type ? { agent: line.subagent_type } : {}),
      ...(line.description ? { description: line.description } : {}),
    });
    const subagent = this.#subagents.get(parent);
    if (!subagent) return events;
    if (line.subtype === "task_started" && line.is_backgrounded !== undefined) subagent.background = line.is_backgrounded;
    if (typeof usage.tool_uses === "number") subagent.toolCalls = Math.max(subagent.toolCalls, usage.tool_uses);
    if (typeof usage.duration_ms === "number") subagent.durationMs = usage.duration_ms;
    if (line.subtype === "task_progress") {
      events.push(...this.#subagentProgress(parent, line.summary || line.description || line.last_tool_name || ""));
    } else if (line.subtype === "task_notification") {
      const status = line.status === "completed" ? "completed" : line.status === "failed" ? "failed" : "aborted";
      events.push(...this.#subagentFinished(parent, status, subagent.lastText ?? line.summary ?? null));
    }
    return events;
  }

  /** `agent.subagent_started`, the first time the turn hears of a subagent. */
  #subagentStarted(parent: string, seen: { agent?: string; description?: string }): DomainEvent[] {
    if (this.#subagents.has(parent) || this.#finishedSubagents.has(parent)) return [];
    const call = this.#agentCalls.get(parent);
    this.#subagents.set(parent, { background: false, toolCalls: 0, lastProgressAt: -Infinity, lastText: null });
    return [
      {
        type: "agent.subagent_started",
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        subagentId: parent,
        parentToolUseId: parent,
        agent: call?.agent ?? seen.agent ?? "general-purpose",
        description: call?.description ?? seen.description ?? null,
        model: null,
      },
    ];
  }

  /** A progress line, at most one a second per subagent: the card's, not a log. */
  #subagentProgress(parent: string, text: string): DomainEvent[] {
    const subagent = this.#subagents.get(parent);
    const summary = text.trim().split("\n")[0]!.slice(0, 300);
    if (!subagent || !summary) return [];
    const now = this.#now();
    if (now - subagent.lastProgressAt < SUBAGENT_PROGRESS_MS) return [];
    subagent.lastProgressAt = now;
    return [
      {
        type: "agent.subagent_progress",
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        subagentId: parent,
        summary,
        toolCalls: subagent.toolCalls,
        ...(subagent.durationMs !== undefined ? { durationMs: subagent.durationMs } : {}),
      },
    ];
  }

  /** `agent.subagent_finished`, once per subagent. */
  #subagentFinished(parent: string, status: "completed" | "failed" | "aborted", result: string | null): DomainEvent[] {
    const subagent = this.#subagents.get(parent);
    if (!subagent) return [];
    this.#subagents.delete(parent);
    this.#finishedSubagents.add(parent);
    const text = result?.trim() || subagent.lastText || null;
    return [
      {
        type: "agent.subagent_finished",
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        subagentId: parent,
        status,
        result: text && text.length > SUBAGENT_RESULT_CHARS ? `${text.slice(0, SUBAGENT_RESULT_CHARS)}\n[… truncated]` : text,
        toolCalls: subagent.toolCalls,
        ...(subagent.durationMs !== undefined ? { durationMs: subagent.durationMs } : {}),
      },
    ];
  }

  /** The turn ended with subagents still running: they ended with it. */
  #closeSubagents(status: "aborted" | "failed" = "aborted"): DomainEvent[] {
    return [...this.#subagents.keys()].flatMap((parent) => this.#subagentFinished(parent, status, null));
  }

  #flushMessage(): DomainEvent[] {
    if (!this.#message || this.#message.content.length === 0) {
      this.#message = null;
      return [];
    }
    const content = this.#message.content;
    this.#message = null;
    return [
      {
        type: "agent.message",
        threadId: this.ctx.threadId,
        turnId: this.ctx.turnId,
        content,
      },
    ];
  }

  /** The workspace-relative path a writing tool named, or null. */
  #pathOf(block: Block): string | null {
    if (!block.name || !WRITING_TOOLS.has(block.name)) return null;
    const input = block.input as { file_path?: unknown; notebook_path?: unknown } | null;
    const named = input?.file_path ?? input?.notebook_path;
    if (typeof named !== "string" || named.length === 0) return null;
    return workspaceRelative(this.ctx.workspace, named);
  }
}

/**
 * A path the CLI named, as the harness names it: relative to the workspace,
 * or null when it points anywhere else. A model editing `/etc/hosts` is not
 * a file change in this project.
 */
export function workspaceRelative(workspace: string, named: string): string | null {
  const absolute = isAbsolute(named) ? named : join(workspace, named);
  const rel = relative(workspace, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return normalizeWorkspacePath(rel);
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : "",
      )
      .join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

/**
 * The CLI's ways of saying its login is gone: the access token expired and
 * the refresh token was refused (it has been revoked, or rotated by another
 * process sharing the same login), or there was never a login at all.
 */
const AUTH_FAILURE =
  /OAuth session expired|could not be refreshed|OAuth token (has )?expired|invalid_grant|authentication_error|Failed to authenticate|Invalid API key|Please run \/login/i;

/**
 * Claude Code's words for a usage limit, as 2.1.316 writes them (read from
 * its binary, and `fixtures/claude-limit.jsonl`): "You've hit your limit ·
 * resets 10:06am", "You've hit your weekly limit", "… monthly spend limit",
 * "You've hit your team's shared budget", "Usage limit reached", and the
 * older "Claude AI usage limit reached|<epoch>". The text is the fallback:
 * `api_error: "usage_limit_reached"` and a refused `rate_limit_event` say it
 * first.
 */
const CLAUDE_LIMIT =
  /\bYou['’]ve hit your [^\n]*(?:limit|budget)\b|\busage limit reached\b|\bspend limit reached\b/i;

/** Whether a line is an API refusal for the plan's usage limit. */
function isLimitLine(line: Line): boolean {
  return line.api_error === "usage_limit_reached" || line.error === "billing_error";
}

/** Whether a failure's text says the subscription hit its limit. */
export function isClaudeLimit(message: string): boolean {
  return CLAUDE_LIMIT.test(message);
}

/**
 * A failed turn's error, with what to do about it when the cause is the
 * login. The CLI's own message is kept at the end for whoever debugs it.
 * Nothing in the harness can renew a refused login: a person has to sign in.
 */
export function explainClaudeError(message: string): string {
  if (!AUTH_FAILURE.test(message)) return message;
  return (
    "Claude Code's sign-in has expired and could not be renewed. Sign in again under " +
    "Settings → Agent Providers → Claude Code, or store a setup token there: it lasts a " +
    `year and never needs renewing. (${message})`
  );
}

function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const e = error as { type?: unknown; message?: unknown; status?: unknown };
    if (typeof e.type === "string") return e.type;
    if (typeof e.status === "number") return `http_${e.status}`;
    if (typeof e.message === "string") return e.message;
  }
  return "unknown";
}

export function mapUsage(usage: Record<string, unknown> | undefined): TokenUsage {
  const n = (key: string) => {
    const value = usage?.[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  };
  return {
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    cacheReadInputTokens: n("cache_read_input_tokens"),
    cacheCreationInputTokens: n("cache_creation_input_tokens"),
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly label = "Claude Code";
  readonly models = CLAUDE_MODELS;
  #caps: ClaudeCapabilities | null = null;

  constructor(private readonly bin: string) {}

  async probe(ctx: RunContext): Promise<ProviderHealth> {
    const { caps, ...health } = await probeClaude(ctx, this.bin);
    if (health.installed) this.#caps = caps;
    return health;
  }

  run(input: ProviderRunInput): AgentRun {
    // Assume the modern flags when nothing has probed yet: they exist on the
    // pinned version, and the settings page probes long before a turn runs.
    const caps = this.#caps ?? { permissionPrompts: true, settingSources: true, mcpConfig: true };
    const normaliser = new ClaudeNormaliser({
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.ctx.cwd,
    });
    return runCli({
      provider: "claude",
      ctx: input.mcpConfigPath
        ? { ...input.ctx, env: { ...input.ctx.env, MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS) } }
        : input.ctx,
      spec: {
        argv: claudeArgv({
          bin: this.bin,
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.instructions ? { appendSystemPrompt: input.instructions } : {}),
          ...(input.mcpConfigPath ? { mcpConfigPath: input.mcpConfigPath } : {}),
          caps,
        }),
        stdin: `${JSON.stringify(userLine(input.prompt))}\n`,
        holdStdin: true,
      },
      normaliser,
    });
  }
}

/** The prompt as `--input-format stream-json` wants it. */
export function userLine(prompt: string): { type: "user"; message: { role: "user"; content: string } } {
  return { type: "user", message: { role: "user", content: prompt } };
}
