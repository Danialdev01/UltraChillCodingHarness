import type { DomainEvent, TokenUsage } from "@ucch/protocol";
import { workspaceRelative } from "./claude.js";
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
 * Codex as a provider: `codex exec --json`, JSONL on stdout.
 *
 * Its items are message-granular, not token-granular: a whole assistant
 * message arrives at once. The chat already tolerates that -- a delta is a
 * delta whatever its size -- and the durable `agent.message` follows each
 * one so a reload rebuilds the same prose.
 *
 * **Never pass `--ephemeral`.** It skips the rollout file that `exec resume`
 * needs, and a thread that cannot resume is a thread that forgets its own
 * work. `codexArgv` has a test for it.
 */

export const CODEX_MODELS = [
  { id: "gpt-5-codex", name: "GPT-5 Codex" },
  { id: "gpt-5", name: "GPT-5" },
] as const;

/**
 * Shown before Codex subscription mode can be enabled. OpenAI's guidance is
 * conservative here, and the honest thing is to repeat it in plain words
 * rather than bury it: the person chose, and the harness said what it knew.
 */
export const CODEX_SUBSCRIPTION_WARNING =
  "Codex subscription auth in automation is an advanced path. OpenAI's guidance is to use an " +
  "API key for programmatic runs, and not to use account auth for public or open-source " +
  "repositories. Your ChatGPT credentials will be stored on this server and used to run agents " +
  "in containers you control. Only enable this on a machine you own and for repositories you trust.";

export interface CodexCapabilities {
  ignoreRules: boolean;
}

export function codexArgv(input: {
  bin: string;
  model?: string;
  resumeToken?: string;
  /** Whether the workspace is a git repository. Codex refuses one that is not, unless told. */
  isRepo: boolean;
  caps: CodexCapabilities;
}): string[] {
  const argv = [input.bin, "exec"];
  if (input.resumeToken) argv.push("resume", input.resumeToken);
  argv.push("--json");
  // The default sandbox is read-only, which makes the agent look broken.
  // Full access is not offered: this is not yet a container.
  argv.push("--sandbox", "workspace-write");
  if (!input.isRepo) argv.push("--skip-git-repo-check");
  // A cloned repository's own `.rules` is model-visible instruction from a
  // stranger, so it does not apply.
  if (input.caps.ignoreRules) argv.push("--ignore-rules");
  if (input.model) argv.push("--model", input.model);
  return argv;
}

/**
 * The message a Codex run is given.
 *
 * `codex exec` has no flag for adding to its instructions that every version
 * has, so the project's knowledge goes ahead of a new session's first
 * message. A resumed session already has it in its history.
 */
export function codexPrompt(prompt: string, instructions?: string, resumeToken?: string): string {
  if (!instructions || resumeToken) return prompt;
  return `<project-knowledge>\n${instructions}\n</project-knowledge>\n\n${prompt}`;
}

export async function probeCodex(
  ctx: RunContext,
  bin: string,
): Promise<ProviderHealth & { caps: CodexCapabilities }> {
  const caps: CodexCapabilities = { ignoreRules: false };
  const forbidden = forbiddenEnvPresent(ctx.env);
  const warnings = [CODEX_SUBSCRIPTION_WARNING];
  if (forbidden) warnings.push(`${forbidden} is set in the provider environment; runs would bill an API key.`);

  const base = (over: Partial<ProviderHealth>): ProviderHealth & { caps: CodexCapabilities } => ({
    installed: false,
    authenticated: false,
    authMode: "none",
    warnings,
    ...over,
    caps,
  });

  const spec = (argv: string[]) => ({ argv: [bin, ...argv], cwd: ctx.cwd, env: ctx.env });
  const version = await ctx.host.run(spec(["--version"]), { timeoutMs: 15_000 }).catch(() => null);
  if (!version || version.code !== 0) {
    return base({ error: version?.stderr.trim() || "codex is not installed" });
  }

  const help = await ctx.host.run(spec(["exec", "--help"]), { timeoutMs: 15_000 }).catch(() => null);
  caps.ignoreRules = (help?.stdout ?? "").includes("--ignore-rules");

  // `codex login status` says how, in prose, and exits non-zero when not at
  // all. The credential file itself is never opened: it is a password.
  const status = await ctx.host
    .run(spec(["login", "status"]), { timeoutMs: 15_000 })
    .catch(() => null);
  const text = `${status?.stdout ?? ""}\n${status?.stderr ?? ""}`;
  const loggedIn = status?.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
  const authMode: ProviderHealth["authMode"] = !loggedIn
    ? "none"
    : /api key/i.test(text)
      ? "api-key"
      : "subscription";

  return base({
    installed: true,
    version: version.stdout.trim().split(/\s+/).pop(),
    authenticated: loggedIn,
    authMode,
  });
}

/** An item as `codex exec --json` prints it. Only the fields read here. */
interface Item {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: { path?: string; kind?: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
  items?: unknown;
  message?: string;
}

interface Line {
  type?: string;
  thread_id?: string;
  item?: Item;
  usage?: Record<string, unknown>;
  error?: { message?: string } | string;
  message?: string;
}

export class CodexNormaliser implements Normaliser {
  #sessionId: string | null = null;
  #closed = false;
  /** Tool items announced by `item.started`, with when. */
  #started = new Map<string, number>();

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
      case "thread.started":
        if (!line.thread_id) return [];
        this.#sessionId = line.thread_id;
        return [{ type: "agent.session_started", ...ids, provider: "codex", sessionId: line.thread_id }];

      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.#item(line.type, line.item ?? {});

      case "turn.completed":
        this.#closed = true;
        return [
          {
            type: "agent.turn_completed",
            ...ids,
            stopReason: "end_turn",
            usage: mapCodexUsage(line.usage),
            // Codex reports tokens, not money; the subscription is the bill.
            costUsd: 0,
          },
        ];

      case "turn.failed":
      case "error": {
        this.#closed = true;
        const error =
          typeof line.error === "string"
            ? line.error
            : (line.error?.message ?? line.message ?? "codex reported an error");
        return [{ type: "agent.turn_failed", ...ids, error }];
      }

      default:
        return [];
    }
  }

  finish(exit: ExitStatus & { interrupted: boolean; stderrTail: string }): DomainEvent[] {
    if (this.#closed) return [];
    this.#closed = true;
    const ids = { threadId: this.ctx.threadId, turnId: this.ctx.turnId };
    if (exit.interrupted && (exitedBySignal(exit) || exit.code === 0)) {
      return [
        {
          type: "agent.turn_completed",
          ...ids,
          stopReason: "cancelled",
          usage: mapCodexUsage(undefined),
          costUsd: 0,
        },
      ];
    }
    const why = exit.stderrTail || (exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`);
    return [{ type: "agent.turn_failed", ...ids, error: `codex exited with ${why}` }];
  }

  #now(): number {
    return (this.ctx.now ?? Date.now)();
  }

  #item(phase: string, item: Item): DomainEvent[] {
    const ids = { threadId: this.ctx.threadId, turnId: this.ctx.turnId };
    const completed = phase === "item.completed";
    const id = item.id ?? "";

    switch (item.type) {
      case "agent_message":
        if (!completed || !item.text) return [];
        return [
          { type: "agent.text_delta", ...ids, text: item.text },
          { type: "agent.message", ...ids, content: [{ type: "text", text: item.text }] },
        ];

      case "reasoning":
        if (!completed || !item.text) return [];
        return [{ type: "agent.thinking_delta", ...ids, text: item.text }];

      case "command_execution":
        return this.#tool(phase, id, "bash", { command: item.command ?? "" }, () => ({
          content: item.aggregated_output ?? "",
          isError: (item.exit_code ?? 0) !== 0 || item.status === "failed",
        }));

      case "file_change": {
        if (!completed) return [];
        const changes = (item.changes ?? []).filter((c) => typeof c.path === "string");
        const events = this.#tool(
          "item.completed",
          id,
          "file_change",
          { changes },
          () => ({
            content: changes.map((c) => `${c.kind ?? "update"} ${c.path}`).join("\n"),
            isError: item.status === "failed",
          }),
        );
        if (item.status === "failed") return events;
        for (const change of changes) {
          const path = workspaceRelative(this.ctx.workspace, change.path!);
          if (!path) continue;
          events.push({
            type: "file.changed",
            projectId: this.ctx.projectId,
            path,
            change: change.kind === "add" ? "added" : change.kind === "delete" ? "deleted" : "modified",
          });
        }
        return events;
      }

      case "mcp_tool_call":
        return this.#tool(
          phase,
          id,
          `mcp:${item.server ?? "server"}.${item.tool ?? "tool"}`,
          item.arguments ?? null,
          () => ({
            content: item.error ? describe(item.error) : describe(item.result),
            isError: Boolean(item.error) || item.status === "failed",
          }),
        );

      case "web_search":
        return this.#tool(phase, id, "web_search", { query: item.query ?? "" }, () => ({
          content: "",
          isError: false,
        }));

      case "todo_list":
        return this.#tool(phase, id, "plan_update", { items: item.items ?? [] }, () => ({
          content: "",
          isError: false,
        }));

      case "error":
        return [{ type: "agent.turn_failed", ...ids, error: item.message ?? "codex reported an error" }];

      default:
        return [];
    }
  }

  /**
   * A tool's lifecycle as two events. The call is written when the item is
   * first seen -- on `started` normally, but lazily on `completed` for an
   * item that arrived whole -- and the result when it completes.
   */
  #tool(
    phase: string,
    id: string,
    name: string,
    input: unknown,
    result: () => { content: string; isError: boolean },
  ): DomainEvent[] {
    const ids = { threadId: this.ctx.threadId, turnId: this.ctx.turnId };
    const events: DomainEvent[] = [];
    if (!this.#started.has(id)) {
      this.#started.set(id, this.#now());
      events.push({ type: "agent.tool_use", ...ids, toolUseId: id, name, input });
    }
    if (phase !== "item.completed") return events;
    const startedAt = this.#started.get(id) ?? this.#now();
    this.#started.delete(id);
    const { content, isError } = result();
    events.push({
      type: "agent.tool_result",
      ...ids,
      toolUseId: id,
      content,
      isError,
      durationMs: Math.max(0, this.#now() - startedAt),
    });
    return events;
  }
}

function describe(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function mapCodexUsage(usage: Record<string, unknown> | undefined): TokenUsage {
  const n = (key: string) => {
    const value = usage?.[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  };
  return {
    inputTokens: n("input_tokens"),
    outputTokens: n("output_tokens"),
    cacheReadInputTokens: n("cached_input_tokens"),
    cacheCreationInputTokens: 0,
  };
}

export class CodexProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly label = "Codex";
  readonly models = CODEX_MODELS;
  #caps: CodexCapabilities | null = null;

  constructor(
    private readonly bin: string,
    /** Whether `cwd` is a git repository; the server knows, the package does not look. */
    private readonly isRepo: (cwd: string) => boolean = () => true,
  ) {}

  async probe(ctx: RunContext): Promise<ProviderHealth> {
    const { caps, ...health } = await probeCodex(ctx, this.bin);
    if (health.installed) this.#caps = caps;
    return health;
  }

  run(input: ProviderRunInput): AgentRun {
    const caps = this.#caps ?? { ignoreRules: false };
    const normaliser = new CodexNormaliser({
      projectId: input.projectId,
      threadId: input.threadId,
      turnId: input.turnId,
      workspace: input.ctx.cwd,
    });
    return runCli({
      ctx: input.ctx,
      spec: {
        argv: codexArgv({
          bin: this.bin,
          ...(input.model ? { model: input.model } : {}),
          ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
          isRepo: this.isRepo(input.ctx.cwd),
          caps,
        }),
        stdin: codexPrompt(input.prompt, input.instructions, input.resumeToken),
      },
      normaliser,
    });
  }
}
