import type { AgentPermissionMode, DomainEvent, ReasoningEffort, TokenUsage } from "@ucch/protocol";
import { workspaceRelative } from "./claude.js";
import type {
  OmpAgentEnd,
  OmpClientFrame,
  OmpFrame,
  OmpHostToolCall,
  OmpHostToolCancel,
  OmpPromptResult,
  OmpToolExecutionEnd,
  OmpToolExecutionStart,
  OmpToolResult,
  OmpUiRequest,
} from "./omp-rpc-types.js";
import { OmpRpc } from "./omp-rpc.js";
import type { ExitStatus } from "./process.js";
import {
  forbiddenEnvFor,
  type AgentProvider,
  type HostToolResult,
  type AgentRun,
  type PermissionReply,
  type ProviderHealth,
  type ProviderRunInput,
  type RunContext,
} from "./types.js";

/**
 * OMP (oh-my-pi) as a provider: `omp --mode rpc-ui`, one process per turn,
 * talked to over JSONL (`omp-rpc.ts`). Design: documentation/omp/solution.md
 * §3; what the pinned version actually does: spike-report.md.
 *
 * Three flags are load-bearing, and each was measured rather than assumed:
 *
 * **`--mode rpc-ui`, not `rpc`.** Only `rpc-ui` asks the host about a tool
 * call (an `extension_ui_request` "Allow tool: …"); plain `rpc` has no one
 * to ask, so the approval mode could never reach the person. The cost is
 * that `rpc-ui` runs shell commands without a PTY, which a turn with
 * `CI=1` and `TERM=dumb` does not miss.
 *
 * **`--no-extensions`, always.** UCCH clones anything, and a repository's
 * `.omp/hooks/` is code that would run as the server user. The flag also
 * stops user-scope hooks and makes custom agents unrunnable, so UCCH's own
 * guard comes in through `--hook`, the one path it leaves open (OM0.4).
 * `--no-rules` likewise keeps a repository's `.omp/RULES.md` out of the
 * prompt, and an untrusted project adds `--no-lsp`: its `lsp.json`, at the
 * root or in `.omp/`, names a command OMP would run.
 *
 * **`--config <overlay>`.** The overlay outranks project config only for
 * the keys it names, so it names every policy key, the whole approval
 * table included (§4). It is per run, written by the server and deleted
 * after the turn.
 */

/** What `--approval-mode` gets for each UCCH permission mode (solution §3.2). */
export function approvalFor(mode: AgentPermissionMode | undefined): "always-ask" | "write" | "yolo" {
  switch (mode) {
    case "strict":
      // Reads run; writes and commands ask.
      return "always-ask";
    case "allow_all":
      return "yolo";
    default:
      // Reads and writes run; commands, `eval`, `browser` and `task` ask.
      return "write";
  }
}

/** `--thinking` for an effort, or null for none: `off` leaves the model's default. */
export function thinkingFor(effort: ReasoningEffort | undefined): string | null {
  if (!effort || effort === "off") return null;
  // OMP's levels include every one UCCH has, under the same names.
  return effort;
}

export function ompArgv(input: {
  bin: string;
  /** The per-run overlay (solution §4). */
  overlayPath: string;
  /** `<subject>/omp/sessions/<projectId>`: where sessions live and `--resume` looks. */
  sessionDir: string;
  /** Absolute path of the subject's copy of the guard hook (§3.9). */
  guardHookPath: string;
  /** A project a person has marked trusted keeps its language servers. */
  trusted: boolean;
  /** `openrouter/<OpenRouter id>`. Absent, OMP uses the overlay's default role. */
  model?: string;
  effort?: ReasoningEffort;
  /** The OMP session id of the thread's previous turn. */
  resumeToken?: string;
  permissionMode?: AgentPermissionMode;
  /**
   * Added to OMP's system prompt: the project's knowledge and UCCH's own
   * section. Sent on resumed turns too, since a session keeps the
   * conversation, not the flags it was started with.
   */
  appendSystemPrompt?: string;
  /** A wall-clock limit, `--max-time` syntax (`45m`). */
  maxTime?: string;
}): string[] {
  const argv = [
    input.bin,
    "--mode",
    "rpc-ui",
    "--config",
    input.overlayPath,
    "--session-dir",
    input.sessionDir,
    "--approval-mode",
    approvalFor(input.permissionMode),
    "--no-extensions",
    "--no-rules",
    // A title costs a model call per session and UCCH names threads itself.
    "--no-title",
    "--hook",
    input.guardHookPath,
  ];
  if (!input.trusted) argv.push("--no-lsp");
  if (input.model) argv.push("--model", input.model);
  const thinking = thinkingFor(input.effort);
  if (thinking) argv.push("--thinking", thinking);
  // Works in RPC mode with --session-dir. An unknown id exits 1 before
  // `ready`, and the turn fails with OMP's "not found" (spike report, OM0.3).
  if (input.resumeToken) argv.push("--resume", input.resumeToken);
  if (input.appendSystemPrompt) {
    // OMP reads this flag as "text or file contents": a value naming a file
    // that exists is replaced by the file. Knowledge comes from the
    // repository, so a project whose knowledge is just `/etc/passwd` would
    // put that file in the prompt. A trailing newline makes it text, always
    // (measured with 18.14.1).
    const text = input.appendSystemPrompt;
    argv.push("--append-system-prompt", text.endsWith("\n") ? text : `${text}\n`);
  }
  if (input.maxTime) argv.push("--max-time", input.maxTime);
  return argv;
}

// -- Normalising the RPC stream ------------------------------------------------

/** What `get_session_stats` reports (fixtures/omp-plain.jsonl). Cumulative per session. */
export interface OmpSessionStats {
  sessionId?: string;
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  cost?: number;
  contextUsage?: { tokens?: number; contextWindow?: number; percent?: number };
  [key: string]: unknown;
}

/**
 * OMP's tool names, as the chat names the native loop's: the same tool
 * should read the same whichever harness ran it. Anything else passes
 * through unchanged.
 */
const TOOL_NAMES: Record<string, string> = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
};

/** The size a stored tool result is held to: the native loop's own bound. */
const RESULT_BYTES = 30_000;

const APPROVAL_TITLE = /^Allow tool:\s*(.+)$/;

/** Dialogs that block OMP until answered. Anything else is a notification. */
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

interface RunningCall {
  toolUseId: string;
  name: string;
  input: unknown;
  startedAt: number;
  /** Workspace-relative files a successful call changes, and how. */
  changes: { path: string; change: "added" | "modified" | "deleted" }[];
}

/**
 * Turns OMP's RPC frames into the harness's events (solution §3.4).
 *
 * Fed by the provider: every frame `OmpRpc` hands on goes to `push`, and the
 * answers OMP gives to commands come in through `session` (the `get_state`
 * after `ready`) and `complete` (the stats after the turn). It writes back to
 * OMP only through `bind`'s `send`: permission answers, and a `cancelled`
 * for every dialog the chat has no surface for.
 *
 * A turn is over when both its terminal `agent_end` and its `prompt_result`
 * have arrived, in either order: with a background task the `prompt_result`
 * comes first and a non-terminal `agent_end` precedes the real one; after an
 * API error the terminal `agent_end` comes first and the `prompt_result`
 * says it failed (OMP exits 0 regardless). `settled` says when.
 */
export class OmpNormaliser {
  #sessionId: string | null = null;
  #closed = false;
  #interrupted = false;
  #ended = false;
  #result: { status: string; error: string | null } | null = null;
  #stopReason: string | null = null;
  #lastError: string | null = null;
  #running: RunningCall[] = [];
  #prompts = new Map<string, true>();
  #io: { send(frame: OmpClientFrame): void } | null = null;

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

  /** The turn's terminal `agent_end` and its `prompt_result` have both arrived. */
  get settled(): boolean {
    return this.#ended && this.#result !== null;
  }

  /** The terminal `agent_end` has arrived, whatever the `prompt_result`. */
  get ended(): boolean {
    return this.#ended;
  }

  bind(io: { send(frame: OmpClientFrame): void }): void {
    this.#io = io;
  }

  noteInterrupt(): void {
    this.#interrupted = true;
  }

  /** The session the turn runs in, from `get_state`: the thread's next resume token. */
  session(sessionId: string): DomainEvent[] {
    if (!sessionId || sessionId === this.#sessionId) return [];
    this.#sessionId = sessionId;
    return [{ type: "agent.session_started", ...this.#ids(), provider: "omp", sessionId }];
  }

  /**
   * Answers an approval this stream raised. OMP takes the option's label;
   * "Approve … for this session" is never sent, because UCCH's own Allow All
   * is the session-wide answer and OMP's would outlive the person's choice.
   */
  answerPermission(requestId: string, reply: PermissionReply): DomainEvent[] {
    if (!this.#prompts.has(requestId) || !this.#io) return [];
    this.#prompts.delete(requestId);
    this.#io.send({ type: "extension_ui_response", id: requestId, value: reply.behavior === "allow" ? "Approve" : "Deny" });
    return [{ type: "agent.permission_resolved", ...this.#ids(), requestId, behavior: reply.behavior }];
  }

  /**
   * Answers every open approval with a cancel, for an interrupt: OMP does
   * not take `abort` while a dialog waits (OM2.4), so the dialogs go first.
   */
  cancelPrompts(): DomainEvent[] {
    for (const id of this.#prompts.keys()) this.#io?.send({ type: "extension_ui_response", id, cancelled: true });
    return this.#closePrompts();
  }

  push(frame: OmpFrame): DomainEvent[] {
    if (this.#closed) return [];
    const ids = this.#ids();
    switch (frame.type) {
      case "message_update": {
        const event = (frame as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
        if (typeof event?.delta !== "string" || event.delta === "") return [];
        if (event.type === "text_delta") return [{ type: "agent.text_delta", ...ids, text: event.delta }];
        if (event.type === "thinking_delta") return [{ type: "agent.thinking_delta", ...ids, text: event.delta }];
        return [];
      }

      case "message_end": {
        const message = (frame as { message?: OmpMessage }).message;
        if (message?.role !== "assistant") return [];
        this.#stopReason = message.stopReason ?? null;
        this.#lastError = message.stopReason === "error" ? (message.errorMessage ?? "the model returned an error") : null;
        const content = Array.isArray(message.content) ? message.content.map((block) => this.#blockOf(block)) : [];
        return content.length ? [{ type: "agent.message", ...ids, content }] : [];
      }

      case "tool_execution_start": {
        const start = frame as OmpToolExecutionStart;
        const { name, input } = this.#toolOf(start.toolName, start.args);
        this.#running.push({
          toolUseId: start.toolCallId,
          name,
          input,
          startedAt: this.#now(),
          changes: this.#changesOf(start.toolName, start.args),
        });
        return [{ type: "agent.tool_use", ...ids, toolUseId: start.toolCallId, name, input }];
      }

      case "tool_execution_end": {
        const end = frame as OmpToolExecutionEnd;
        const at = this.#running.findIndex((call) => call.toolUseId === end.toolCallId);
        if (at === -1) return [];
        const [call] = this.#running.splice(at, 1);
        const isError = end.isError === true;
        const events: DomainEvent[] = [
          {
            type: "agent.tool_result",
            ...ids,
            toolUseId: end.toolCallId,
            content: clampResult(resultText(end.result)),
            isError,
            durationMs: Math.max(0, Math.round(this.#now() - call!.startedAt)),
          },
        ];
        if (!isError) {
          for (const { path, change } of call!.changes) {
            events.push({ type: "file.changed", projectId: this.ctx.projectId, path, change });
          }
        }
        return events;
      }

      case "extension_ui_request":
        return this.#uiRequest(frame as OmpUiRequest);

      case "auto_retry_start": {
        const retry = frame as { attempt?: unknown; maxAttempts?: unknown; delayMs?: unknown; errorMessage?: unknown };
        return [
          {
            type: "agent.retry",
            ...ids,
            attempt: count(retry.attempt),
            maxRetries: count(retry.maxAttempts),
            delayMs: count(retry.delayMs),
            category: typeof retry.errorMessage === "string" ? retry.errorMessage.split("\n")[0]!.slice(0, 200) : "retry",
          },
        ];
      }

      case "auto_retry_end":
        if ((frame as { success?: unknown }).success === true) this.#lastError = null;
        return [];

      case "auto_compaction_end":
      case "manual_compaction_end": {
        const end = frame as { skipped?: unknown; aborted?: unknown; result?: { summary?: unknown; tokensBefore?: unknown } };
        const summary = end.result?.summary;
        if (end.skipped === true || end.aborted === true || typeof summary !== "string" || summary === "") return [];
        // The method and the size after are not on the frame (spike report,
        // Q4); `OmpTurn` asks the session for them.
        const tokensBefore = tokenCount(end.result?.tokensBefore);
        return [
          {
            type: "context.injected",
            threadId: this.ctx.threadId,
            turnId: this.ctx.turnId,
            source: "compaction",
            content: summary,
            ...(tokensBefore !== undefined ? { compaction: { tokensBefore } } : {}),
          },
        ];
      }

      case "agent_end":
        if ((frame as OmpAgentEnd).isTerminal === false) return [];
        this.#ended = true;
        return this.#closePrompts();

      case "prompt_result": {
        const result = frame as OmpPromptResult;
        this.#result = {
          status: typeof result.status === "string" ? result.status : "completed",
          error: result.error?.message ?? null,
        };
        return [];
      }

      default:
        // `notice`, `session_settled`, `available_commands_update`, the
        // subagent frames (OM5) and whatever the next version adds.
        return [];
    }
  }

  /**
   * Closes a settled turn with what it cost: `before` is the session's stats
   * when the turn started (absent for a new session), `after` when it ended.
   */
  complete(stats: { before?: OmpSessionStats | null; after?: OmpSessionStats | null } = {}): DomainEvent[] {
    if (this.#closed) return [];
    this.#closed = true;
    const ids = this.#ids();
    const events = this.#closePrompts();
    const failure = this.#result?.status === "error" ? (this.#result.error ?? this.#lastError ?? "omp reported an error") : null;
    if (this.#interrupted || this.#stopReason === "aborted") {
      events.push({ type: "agent.turn_completed", ...ids, stopReason: "cancelled", ...cost(stats) });
    } else if (failure) {
      events.push({ type: "agent.turn_failed", ...ids, error: failure });
    } else {
      events.push({ type: "agent.turn_completed", ...ids, stopReason: stopReasonOf(this.#stopReason), ...cost(stats) });
    }
    return events;
  }

  /** The process is gone. Closes the turn if `complete` never did. */
  finish(exit: ExitStatus & { interrupted: boolean; stderrTail: string; error?: string }): DomainEvent[] {
    if (this.#closed) return [];
    if (this.settled) return this.complete();
    this.#closed = true;
    const ids = this.#ids();
    const events = this.#closePrompts();
    if (exit.interrupted || this.#interrupted) {
      events.push({ type: "agent.turn_completed", ...ids, stopReason: "cancelled", usage: ZERO_USAGE, costUsd: 0 });
      return events;
    }
    const why =
      exit.error ??
      (exit.stderrTail.trim() || this.#lastError || (exit.signal ? `omp exited on ${exit.signal}` : `omp exited with code ${String(exit.code)}`));
    events.push({ type: "agent.turn_failed", ...ids, error: why });
    return events;
  }

  #uiRequest(request: OmpUiRequest): DomainEvent[] {
    if (!DIALOGS.has(request.method)) return [];
    const title = typeof request.title === "string" ? request.title : "";
    const approval = request.method === "select" ? APPROVAL_TITLE.exec(title.split("\n")[0] ?? "") : null;
    if (!approval || this.#interrupted) {
      // A question the chat cannot show, or one asked after the stop button:
      // unanswered, OMP would wait forever, and hold the `abort` with it.
      this.#io?.send({ type: "extension_ui_response", id: request.id, cancelled: true });
      return [];
    }
    // Approvals are asked one at a time, for the call that has just started.
    const toolName = approval[1]!.trim();
    const call = [...this.#running].reverse().find((c) => c.toolUseId) ?? null;
    this.#prompts.set(request.id, true);
    return [
      {
        type: "agent.permission_requested",
        ...this.#ids(),
        requestId: request.id,
        toolUseId: call?.toolUseId ?? null,
        toolName: call?.name ?? TOOL_NAMES[toolName] ?? toolName,
        input: call?.input ?? null,
        description: title.split("\n").slice(1).join("\n").trim() || null,
      },
    ];
  }

  /**
   * The name and input the chat shows for a call. A `write` to `xd://<tool>`
   * is a device call -- a host tool, or one of OMP's rarer tools -- so it
   * shows as that tool with its JSON arguments, not as a file write.
   */
  #toolOf(toolName: string, args: Record<string, unknown> | undefined): { name: string; input: unknown } {
    const path = args?.path;
    if (toolName === "write" && typeof path === "string" && path.startsWith("xd://")) {
      const device = path.slice("xd://".length).split("/")[0] || "device";
      let input: unknown = args?.content ?? null;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          /* shown as the text it is */
        }
      }
      return { name: device, input };
    }
    return { name: TOOL_NAMES[toolName] ?? toolName, input: args ?? null };
  }

  /**
   * A content block in the shape the event log already holds (Anthropic's):
   * OMP's `toolCall` becomes `tool_use`, named as its `agent.tool_use` is,
   * with the raw argument string kept as `arguments` the way
   * `session-log.ts` replays it. Text, and anything else, passes through.
   */
  #blockOf(block: unknown): unknown {
    if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "toolCall") return block;
    const call = block as { id?: unknown; name?: unknown; arguments?: unknown; partialArgs?: unknown };
    const args = typeof call.arguments === "object" && call.arguments !== null ? (call.arguments as Record<string, unknown>) : undefined;
    const { name, input } = this.#toolOf(String(call.name ?? ""), args);
    return {
      type: "tool_use",
      id: String(call.id ?? ""),
      name,
      input,
      ...(typeof call.partialArgs === "string" ? { arguments: call.partialArgs } : {}),
    };
  }

  /** What a call will change in the workspace if it succeeds. */
  #changesOf(toolName: string, args: Record<string, unknown> | undefined): RunningCall["changes"] {
    const rel = (named: unknown) => (typeof named === "string" ? workspaceRelative(this.ctx.workspace, named) : null);
    if (toolName === "write") {
      const path = typeof args?.path === "string" && !args.path.startsWith("xd://") ? rel(args.path) : null;
      return path ? [{ path, change: "modified" }] : [];
    }
    if (toolName === "edit" && typeof args?.input === "string") {
      const changes: RunningCall["changes"] = [];
      for (const op of editOperations(args.input)) {
        const path = rel(op.path);
        if (!path) continue;
        if (op.removed) changes.push({ path, change: "deleted" });
        else if (op.movedTo) {
          changes.push({ path, change: "deleted" });
          const to = rel(op.movedTo);
          if (to) changes.push({ path: to, change: "added" });
        } else changes.push({ path, change: "modified" });
      }
      return changes;
    }
    return [];
  }

  /** A turn that ends with approvals open answers them: nobody else will. */
  #closePrompts(): DomainEvent[] {
    const events: DomainEvent[] = [];
    for (const requestId of this.#prompts.keys()) {
      events.push({ type: "agent.permission_resolved", ...this.#ids(), requestId, behavior: "deny" });
    }
    this.#prompts.clear();
    return events;
  }

  #ids() {
    return { threadId: this.ctx.threadId, turnId: this.ctx.turnId };
  }

  #now(): number {
    return (this.ctx.now ?? Date.now)();
  }
}

interface OmpMessage {
  role?: string;
  content?: unknown[];
  stopReason?: string;
  errorMessage?: string;
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

/** OMP's stop reasons in the harness's words, where the harness has one. */
function stopReasonOf(reason: string | null): string | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return reason;
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** A token figure OMP reported, or undefined where it reported none. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

type ContextInjected = Extract<DomainEvent, { type: "context.injected" }>;

/**
 * Fills a compaction event's method and size after from the session's
 * newest `compactionSummary` message (`get_messages`, spike report Q4),
 * when it is the one the event reports.
 */
export function describeCompaction(event: ContextInjected, messages: unknown): ContextInjected {
  if (!Array.isArray(messages)) return event;
  const summary = messages.findLast(
    (m): m is { summary?: unknown; method?: unknown; tokensBefore?: unknown; tokensAfter?: unknown } =>
      typeof m === "object" && m !== null && (m as { role?: unknown }).role === "compactionSummary",
  );
  if (!summary || summary.summary !== event.content) return event;
  // Two compactions can write the same summary; the size before tells them apart.
  const before = event.compaction?.tokensBefore;
  if (before !== undefined && tokenCount(summary.tokensBefore) !== undefined && tokenCount(summary.tokensBefore) !== before) {
    return event;
  }
  const method = typeof summary.method === "string" && summary.method ? summary.method.slice(0, 40) : undefined;
  const tokensBefore = before ?? tokenCount(summary.tokensBefore);
  const tokensAfter = tokenCount(summary.tokensAfter);
  return {
    ...event,
    compaction: {
      ...(method ? { method } : {}),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    },
  };
}

/** The turn's usage and cost: the session's totals after it, less those before. */
function cost(stats: { before?: OmpSessionStats | null; after?: OmpSessionStats | null }): { usage: TokenUsage; costUsd: number } {
  const delta = (pick: (s: OmpSessionStats) => unknown) =>
    Math.max(0, count(stats.after ? pick(stats.after) : 0) - count(stats.before ? pick(stats.before) : 0));
  const costOf = (s: OmpSessionStats | null | undefined) => (typeof s?.cost === "number" && Number.isFinite(s.cost) ? s.cost : 0);
  return {
    usage: {
      inputTokens: delta((s) => s.tokens?.input),
      outputTokens: delta((s) => s.tokens?.output),
      cacheReadInputTokens: delta((s) => s.tokens?.cacheRead),
      cacheCreationInputTokens: delta((s) => s.tokens?.cacheWrite),
    },
    costUsd: Math.max(0, costOf(stats.after) - costOf(stats.before)),
  };
}

function resultText(result: OmpToolResult | undefined): string {
  if (!result?.content) return "";
  return result.content.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

/** The native loop's bound: head and tail kept, the middle elided. */
function clampResult(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= RESULT_BYTES) return text;
  const head = Math.floor(RESULT_BYTES * 0.7);
  const tail = RESULT_BYTES - head;
  return (
    bytes.subarray(0, head).toString("utf8") +
    `\n\n… ${(bytes.length - RESULT_BYTES).toLocaleString("en-US")} bytes elided …\n\n` +
    bytes.subarray(bytes.length - tail).toString("utf8")
  );
}

/**
 * The files an `edit` patch touches. Each file's section opens with
 * `[PATH#TAG]`; `REM` deletes it and `MV DEST` renames it.
 */
export function editOperations(patch: string): { path: string; removed: boolean; movedTo: string | null }[] {
  const ops: { path: string; removed: boolean; movedTo: string | null }[] = [];
  for (const line of patch.split("\n")) {
    const header = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/.exec(line);
    if (header) {
      ops.push({ path: header[1]!, removed: false, movedTo: null });
      continue;
    }
    const current = ops.at(-1);
    if (!current) continue;
    if (/^REM\s*$/.test(line)) current.removed = true;
    const move = /^MV\s+(.+?)\s*$/.exec(line);
    if (move) current.movedTo = move[1]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return ops;
}

// -- The provider ---------------------------------------------------------------

/** How long an interrupted turn gets to wind down before it is killed. */
const INTERRUPT_GRACE_MS = 10_000;

/** How long a finished turn's process gets to exit once stdin is closed. */
const CLOSE_GRACE_MS = 10_000;

/** How long a compaction's divider waits for its figures before it goes without them. */
const COMPACTION_LOOKUP_MS = 5_000;

/** Stderr kept for the failure message. The end of it is where the error is. */
const STDERR_TAIL_BYTES = 4 * 1024;

/** The account's OpenRouter id as OMP names it (solution §3.2, OM0). */
export function ompModel(model: string): string {
  return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
}

/**
 * `omp --version` for `installed` and `version`; the OpenRouter key in the
 * environment for `authenticated`, which is how a run bills (§1.4). A login
 * stored by `omp login` is OM8.2's to detect, and is never opened here.
 */
export async function probeOmp(ctx: RunContext, bin: string): Promise<ProviderHealth> {
  const forbidden = forbiddenEnvFor("omp", ctx.env);
  const warnings = forbidden
    ? [`${forbidden} is set in the provider environment; OMP would bill it instead of the OpenRouter key, so runs refuse to start.`]
    : [];
  const version = await ctx.host
    .run({ argv: [bin, "--version"], cwd: ctx.cwd, env: ctx.env }, { timeoutMs: 15_000 })
    .catch(() => null);
  if (!version || version.code !== 0) {
    return {
      installed: false,
      authenticated: false,
      authMode: "none",
      error: version?.stderr.trim() || "omp is not installed",
      ...(warnings.length ? { warnings } : {}),
    };
  }
  const keyed = Boolean(ctx.env.OPENROUTER_API_KEY);
  return {
    installed: true,
    // "omp/18.14.1"
    version: /\d+\.\d+\.\d+\S*/.exec(version.stdout)?.[0] ?? version.stdout.trim(),
    authenticated: keyed,
    authMode: keyed ? "api-key" : "none",
    ...(keyed ? { account: "OpenRouter key" } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Timings, for tests; the defaults are the production ones. */
export interface OmpProviderOptions {
  readyTimeoutMs?: number;
  /** SIGTERM to SIGKILL, in a kill. */
  killGraceMs?: number;
  /** An interrupt to a kill, if the turn has not wound down. */
  interruptGraceMs?: number;
  /** Stdin closed to a kill, if the process has not exited. */
  closeGraceMs?: number;
  onStderr?: (line: string) => void;
}

export class OmpProvider implements AgentProvider {
  readonly id = "omp" as const;
  readonly label = "Custom";
  /** The account's OpenRouter models, as for the native loop: none of OMP's own. */
  readonly models = [] as const;

  constructor(
    private readonly bin: string,
    private readonly options: OmpProviderOptions = {},
  ) {}

  probe(ctx: RunContext): Promise<ProviderHealth> {
    return probeOmp(ctx, this.bin);
  }

  run(input: ProviderRunInput): AgentRun {
    const forbidden = forbiddenEnvFor("omp", input.ctx.env);
    if (forbidden) {
      throw new Error(`${forbidden} is set in the provider environment; refusing to run on a credential other than the OpenRouter key`);
    }
    if (!input.omp) throw new Error("an OMP run needs its overlay, session directory and guard hook");
    const argv = ompArgv({
      bin: this.bin,
      overlayPath: input.omp.overlayPath,
      sessionDir: input.omp.sessionDir,
      guardHookPath: input.omp.guardHookPath,
      trusted: input.omp.trusted,
      ...(input.model ? { model: ompModel(input.model) } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.instructions ? { appendSystemPrompt: input.instructions } : {}),
      ...(input.omp.maxTime ? { maxTime: input.omp.maxTime } : {}),
    });
    return new OmpTurn(input, argv, this.options);
  }
}

/**
 * One turn, one process (solution §3.6): `ready`, the session, the stats
 * before, the prompt, the stream until the turn settles, the stats after,
 * then stdin closed. Every path out -- done, failed, stopped, killed, the
 * process dying -- ends the event stream with exactly one closing event.
 */
class OmpTurn implements AgentRun {
  readonly events: AsyncIterable<DomainEvent>;
  readonly #queue = new EventQueue();
  readonly #normaliser: OmpNormaliser;
  readonly #settled: Promise<void>;
  #settle: () => void = () => {};
  #rpc: OmpRpc | null = null;
  /** Answers sent before the client was ready. */
  #early: OmpClientFrame[] = [];
  #interrupted = false;
  #killed = false;
  #failure: string | null = null;
  #timer: NodeJS.Timeout | undefined;
  /** Host calls running, by OMP's call id, to abort on `host_tool_cancel`. */
  readonly #hostCalls = new Map<string, AbortController>();
  /**
   * Events held while a compaction's figures are asked for, so that what
   * follows the divider still lands after it. Null when nothing is held.
   */
  #held: DomainEvent[] | null = null;
  #described: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: ProviderRunInput,
    argv: string[],
    private readonly options: OmpProviderOptions,
  ) {
    this.events = this.#queue;
    this.#settled = new Promise((resolve) => (this.#settle = resolve));
    this.#normaliser = new OmpNormaliser({
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.ctx.cwd,
    });
    this.#normaliser.bind({ send: (frame) => this.#send(frame) });
    void this.#drive(argv).catch((error: unknown) => this.#end({ code: null, signal: null }, describeError(error)));
  }

  answerPermission(requestId: string, reply: PermissionReply): boolean {
    const events = this.#normaliser.answerPermission(requestId, reply);
    this.#emit(events);
    return events.length > 0;
  }

  async interrupt(): Promise<void> {
    if (this.#interrupted) return;
    this.#interrupted = true;
    this.#normaliser.noteInterrupt();
    this.#emit(this.#normaliser.cancelPrompts());
    // Before the prompt, `#drive` sees the flag and closes instead.
    this.#rpc?.request({ type: "abort" }).catch(() => {});
    this.#timer = setTimeout(() => void this.kill(), this.options.interruptGraceMs ?? INTERRUPT_GRACE_MS);
    this.#timer.unref();
  }

  async kill(): Promise<void> {
    this.#interrupted = true;
    this.#killed = true;
    this.#normaliser.noteInterrupt();
    await this.#rpc?.kill();
  }

  async #drive(argv: string[]): Promise<void> {
    const { ctx } = this.input;
    let rpc: OmpRpc;
    try {
      rpc = await OmpRpc.start({
        host: ctx.host,
        argv,
        cwd: ctx.cwd,
        env: ctx.env,
        onFrame: (frame) => this.#onFrame(frame),
        ...(this.options.onStderr ? { onStderr: this.options.onStderr } : {}),
        ...(this.options.readyTimeoutMs !== undefined ? { readyTimeoutMs: this.options.readyTimeoutMs } : {}),
        ...(this.options.killGraceMs !== undefined ? { killGraceMs: this.options.killGraceMs } : {}),
      });
    } catch (error) {
      // `start` has already killed what it spawned; its message carries the stderr.
      this.#end({ code: null, signal: null }, describeError(error));
      return;
    }
    this.#rpc = rpc;
    for (const frame of this.#early.splice(0)) this.#send(frame);
    try {
      if (this.#killed) await rpc.kill();
      else await this.#turn(rpc);
    } catch (error) {
      // The process went away under a command, or a write failed.
      this.#failure ??= describeError(error);
      await rpc.kill();
    }
    this.#end(await rpc.exited, this.#failure);
  }

  async #turn(rpc: OmpRpc): Promise<void> {
    // Subagent frames are read from OM5; asking now costs nothing.
    await rpc.request({ type: "set_subagent_subscription", level: "progress" });
    const hostTools = this.input.hostTools ?? [];
    if (hostTools.length > 0) {
      // A turn whose tools did not register would tell the model about
      // tools it cannot call; better to fail it than to let it try.
      const registered = await rpc.request({ type: "set_host_tools", tools: [...hostTools] });
      if (!registered.success) {
        this.#failure = `omp refused the host tools: ${registered.error ?? "no reason given"}`;
        return this.#close(rpc);
      }
    }
    const state = await rpc.request<{ sessionId?: unknown }>({ type: "get_state" });
    if (typeof state.data?.sessionId === "string") this.#queue.push(...this.#normaliser.session(state.data.sessionId));
    const before = await this.#stats(rpc);
    if (this.#interrupted) return this.#close(rpc);

    const prompt = await rpc.request({ type: "prompt", message: this.input.prompt });
    if (!prompt.success) {
      this.#failure = prompt.error || "omp refused the prompt";
      return this.#close(rpc);
    }
    const outcome = await Promise.race([this.#settled.then(() => "settled" as const), rpc.exited.then(() => "exited" as const)]);
    // Gone before the turn settled: `#end` reports how.
    if (outcome === "exited") return;
    await this.#described;
    const after = await this.#stats(rpc);
    this.#emit(this.#normaliser.complete({ before, after }));
    await this.#close(rpc);
  }

  #onFrame(frame: OmpFrame): void {
    if (frame.type === "host_tool_call") return this.#hostCall(frame as OmpHostToolCall);
    if (frame.type === "host_tool_cancel") {
      this.#hostCalls.get((frame as OmpHostToolCancel).targetId)?.abort();
      return;
    }
    if (frame.type === "rpc_frame_error") {
      // Part of the turn is lost, so none of it can be trusted.
      this.#failure ??= `omp sent a frame that could not be read: ${String(frame.error)}`;
      void this.#rpc?.kill();
      return;
    }
    const events = this.#normaliser.push(frame);
    const at = events.findIndex((e) => e.type === "context.injected" && e.source === "compaction");
    if (at >= 0 && this.#held === null && this.#rpc) {
      this.#emit(events.slice(0, at));
      this.#held = events.slice(at);
      this.#described = this.#describe(this.#rpc);
    } else this.#emit(events);
    if (this.#normaliser.settled) this.#settle();
  }

  /** Events out, behind any held for a compaction. */
  #emit(events: DomainEvent[]): void {
    if (this.#held) this.#held.push(...events);
    else this.#queue.push(...events);
  }

  /**
   * Asks the session for the compaction just held, fills in its figures,
   * and lets the held events go. A divider without figures is still a
   * divider: no answer in time, or a failed one, sends it as it was.
   */
  async #describe(rpc: OmpRpc): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), COMPACTION_LOOKUP_MS)));
    const response = await Promise.race([
      rpc.request<{ messages?: unknown }>({ type: "get_messages" }).catch(() => null),
      late,
    ]);
    clearTimeout(timer);
    this.#release(response?.success ? response.data?.messages : undefined);
  }

  #release(messages: unknown): void {
    const held = this.#held;
    if (!held) return;
    this.#held = null;
    const [first, ...rest] = held;
    if (first?.type === "context.injected") this.#queue.push(describeCompaction(first, messages));
    this.#queue.push(...rest);
  }

  /**
   * Runs a host call off the read loop, so a slow tool never holds the
   * stream, and answers it. OMP sends the call's own `tool_execution_*`
   * frames, so nothing here becomes an event (spike report, OM0.3).
   *
   * Answered even after a cancel: OMP has ended the call by then and drops
   * the late result (OM3.2), and answering always keeps one path for both.
   */
  #hostCall(call: OmpHostToolCall): void {
    const controller = new AbortController();
    this.#hostCalls.set(call.id, controller);
    const run = this.input.onHostToolCall;
    const pending: Promise<HostToolResult> = run
      ? Promise.resolve().then(() =>
          run(
            {
              id: call.id,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              arguments: call.arguments && typeof call.arguments === "object" ? call.arguments : {},
            },
            controller.signal,
          ),
        )
      : Promise.resolve({ content: `There is no host tool called ${JSON.stringify(call.toolName)}.`, isError: true });
    void pending
      .catch((error: unknown): HostToolResult => ({ content: `${call.toolName} failed: ${describeError(error)}`, isError: true }))
      .then((result) => {
        this.#hostCalls.delete(call.id);
        this.#send({
          type: "host_tool_result",
          id: call.id,
          result: { content: [{ type: "text", text: result.content }] },
          ...(result.isError ? { isError: true } : {}),
        });
      });
  }

  async #stats(rpc: OmpRpc): Promise<OmpSessionStats | null> {
    const response = await rpc.request<OmpSessionStats>({ type: "get_session_stats" });
    return response.success ? (response.data ?? null) : null;
  }

  async #close(rpc: OmpRpc): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), this.options.closeGraceMs ?? CLOSE_GRACE_MS)));
    const outcome = await Promise.race([rpc.close(), late]);
    clearTimeout(timer);
    if (outcome === "late") await rpc.kill();
  }

  #send(frame: OmpClientFrame): void {
    if (!this.#rpc) {
      this.#early.push(frame);
      return;
    }
    try {
      this.#rpc.send(frame);
    } catch {
      // The process is gone; `#drive` reports that.
    }
  }

  #end(exit: ExitStatus, error: string | null): void {
    clearTimeout(this.#timer);
    // Nobody is left to answer: a tool still running stops.
    for (const controller of this.#hostCalls.values()) controller.abort();
    this.#release(undefined);
    const stderrTail = (this.#rpc?.stderrTail ?? "").slice(-STDERR_TAIL_BYTES).trim();
    this.#queue.push(
      ...this.#normaliser.finish({ ...exit, interrupted: this.#interrupted, stderrTail, ...(error ? { error } : {}) }),
    );
    this.#queue.end();
  }
}

/** Events in order, for one reader, until `end`. */
class EventQueue implements AsyncIterable<DomainEvent> {
  #items: DomainEvent[] = [];
  #done = false;
  #wake: (() => void) | null = null;

  push(...events: DomainEvent[]): void {
    if (this.#done || events.length === 0) return;
    this.#items.push(...events);
    this.#wake?.();
  }

  end(): void {
    this.#done = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<DomainEvent> {
    for (;;) {
      while (this.#items.length) yield this.#items.shift()!;
      if (this.#done) return;
      await new Promise<void>((resolve) => (this.#wake = resolve));
      this.#wake = null;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
