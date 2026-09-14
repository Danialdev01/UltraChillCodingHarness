import { isAbsolute, join, relative } from "node:path";
import { normalizeWorkspacePath, type DomainEvent, type TokenUsage } from "@ucch/protocol";
import type { ExitStatus } from "./process.js";
import { exitedBySignal, runCli, type Normaliser } from "./run.js";
import type {
  AgentProvider,
  AgentRun,
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
export const CLAUDE_MODELS = [
  { id: "sonnet", name: "Claude Sonnet" },
  { id: "opus", name: "Claude Opus" },
  { id: "haiku", name: "Claude Haiku" },
] as const;

/** Flags that exist only from certain CLI versions on. Detected, not assumed. */
export interface ClaudeCapabilities {
  permissionPrompts: boolean;
  settingSources: boolean;
}

export function claudeArgv(input: {
  bin: string;
  model?: string;
  resumeToken?: string;
  caps: ClaudeCapabilities;
}): string[] {
  const argv = [
    input.bin,
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // `-p` starts at manual on every plan, so a mode must be named. Edits in
    // the workspace are the point; nothing here ever ships bypassPermissions.
    "--permission-mode",
    "acceptEdits",
  ];
  // Tells the CLI nobody can approve and not to wait for anyone: without it
  // a run that hits something acceptEdits does not cover can stall.
  if (input.caps.permissionPrompts) argv.push("--permission-prompts", "none");
  // The user's settings only. A cloned repository's `.claude/settings.json`
  // -- its hooks, its MCP servers -- is model-visible instruction from
  // whoever wrote the repository, and this is a harness that clones anything.
  if (input.caps.settingSources) argv.push("--setting-sources", "user");
  if (input.model) argv.push("--model", input.model);
  if (input.resumeToken) argv.push("--resume", input.resumeToken);
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
  const caps: ClaudeCapabilities = { permissionPrompts: false, settingSources: false };
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
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Line {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
  message?: { id?: string; content?: Block[] };
  tool_use_result?: { type?: string };
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error?: unknown;
  is_error?: boolean;
  result?: string | null;
  terminal_reason?: string;
  total_cost_usd?: number;
  usage?: Record<string, unknown>;
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
  /** The response being assembled: blocks so far, keyed by message id. */
  #message: { id: string; content: unknown[] } | null = null;
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

  push(raw: string): DomainEvent[] {
    if (!raw.trim().startsWith("{")) return [];
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

      case "stream_event": {
        // Subagent prose is not this turn's prose; its tool calls still
        // arrive as ordinary assistant lines below.
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
        }
        return events;
      }

      case "result": {
        this.#closed = true;
        const events = this.#flushMessage();
        if (line.session_id) this.#sessionId = line.session_id;
        this.#usage = mapUsage(line.usage);
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
          events.push({
            type: "agent.turn_failed",
            ...ids,
            error: line.result?.trim() || line.subtype || "claude reported an error",
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
        // `rate_limit_event`, `system/status`, `permission_denied` and whatever
        // next week's release adds. Unknown is ignored, never fatal.
        return [];
    }
  }

  finish(exit: ExitStatus & { interrupted: boolean; stderrTail: string }): DomainEvent[] {
    if (this.#closed) return [];
    this.#closed = true;
    const ids = { threadId: this.ctx.threadId, turnId: this.ctx.turnId };
    const events = this.#flushMessage();
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
    events.push({ type: "agent.turn_failed", ...ids, error: `claude exited with ${why}` });
    return events;
  }

  #now(): number {
    return (this.ctx.now ?? Date.now)();
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
    const caps = this.#caps ?? { permissionPrompts: true, settingSources: true };
    const normaliser = new ClaudeNormaliser({
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.ctx.cwd,
    });
    return runCli({
      ctx: input.ctx,
      spec: {
        argv: claudeArgv({
          bin: this.bin,
          ...(input.model ? { model: input.model } : {}),
          ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
          caps,
        }),
        stdin: input.prompt,
      },
      normaliser,
    });
  }
}
