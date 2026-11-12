import { CodexSubagents, withCodexSubagents } from "./codex-subagents.js";
import type { DomainEvent, ReasoningEffort, TokenUsage } from "@ucch/protocol";
import { CODEX_IMAGE_INSTRUCTIONS, rolloutImagePaths, withCodexImages } from "./codex-images.js";
import { workspaceRelative } from "./claude.js";
import type { ExitStatus } from "./process.js";
import { exitedBySignal, runCli, type Normaliser } from "./run.js";
import type {
  AgentProvider,
  AgentRun,
  ProviderHealth,
  ProviderModel,
  CodexMcpServer,
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

/**
 * Fallback for older CLIs without model discovery. Not a whitelist: `--model`
 * takes any id the account's plan has, and a subagent asked for by name
 * ("gpt6 sol") is passed through as `parseModelRequest` spelled it.
 */
const CODEX_DEFAULT_EFFORTS = ["low", "medium", "high"] as const;
const CODEX_EFFORTS: readonly ReasoningEffort[] = [...CODEX_DEFAULT_EFFORTS, "xhigh", "max"];

export const CODEX_MODELS = [
  { id: "gpt-5-codex", name: "GPT-5 Codex", efforts: CODEX_DEFAULT_EFFORTS },
  { id: "gpt-5", name: "GPT-5", efforts: CODEX_DEFAULT_EFFORTS },
] as const;

/** Read the CLI's catalogue without starting an inference turn or reading credentials. */
export async function listCodexModels(ctx: RunContext, bin: string): Promise<ProviderModel[]> {
  const child = ctx.host.spawn({
    argv: [bin, "app-server"], cwd: ctx.cwd, env: ctx.env, holdStdin: true,
    stdin: JSON.stringify({ id: 1, method: "initialize", params: {
      clientInfo: { name: "ucch", version: "1.0.0" },
    } }) + "\n",
  });
  const models = new Map<string, ProviderModel>();
  const cursors = new Set<string>();
  let requestId = 1;
  const send = (message: object) => child.write(JSON.stringify(message) + "\n");
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Codex model discovery timed out")), 15_000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      for await (const { stream, line } of child.lines) {
        if (stream !== "stdout") continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== requestId) continue;
        if (message.error) throw new Error("Codex model discovery failed");
        if (requestId === 1) {
          send({ method: "initialized", params: {} });
          send({ id: ++requestId, method: "model/list", params: { limit: 100 } });
          continue;
        }
        if (!Array.isArray(message.result?.data)) throw new Error("Invalid Codex model catalogue");
        for (const entry of message.result.data) {
          if (!entry || entry.hidden === true || typeof entry.model !== "string" || !entry.model.trim()) continue;
          // Older CLIs omit this field; an explicit empty list means no control.
          const efforts = Array.isArray(entry.supportedReasoningEfforts)
            ? CODEX_EFFORTS.filter((effort) => entry.supportedReasoningEfforts.some(
              (option: unknown) => typeof option === "object" && option !== null &&
                "reasoningEffort" in option && option.reasoningEffort === effort,
            ))
            : CODEX_DEFAULT_EFFORTS;
          models.set(entry.model, {
            id: entry.model,
            name: typeof entry.displayName === "string" && entry.displayName.trim() ? entry.displayName : entry.model,
            efforts,
          });
        }
        const cursor = message.result.nextCursor;
        if (typeof cursor === "string" && cursor) {
          if (cursors.has(cursor)) throw new Error("Repeated Codex model cursor");
          cursors.add(cursor);
          send({ id: ++requestId, method: "model/list", params: { limit: 100, cursor } });
          continue;
        }
        if (!models.size) throw new Error("Empty Codex model catalogue");
        return [...models.values()];
      }
      throw new Error("Codex exited before returning its model catalogue");
    })()]);
  } finally {
    clearTimeout(timer!);
    child.endStdin();
    child.signal("SIGKILL");
    await child.exited;
  }
}

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
  effort?: ReasoningEffort;
  resumeToken?: string;
  /** Whether the workspace is a git repository. Codex refuses one that is not, unless told. */
  isRepo: boolean;
  caps: CodexCapabilities;
  /** The OMP bridge (solution §10.3). Absent: no MCP server is added. */
  mcp?: CodexMcpServer;
}): string[] {
  const argv = [input.bin, "exec"];
  argv.push("--json");
  // The default sandbox is read-only, which makes the agent look broken.
  // Full access is not offered: this is not yet a container.
  argv.push("--sandbox", "workspace-write");
  // Subscription image generation must be available in headless chat turns too.
  argv.push("-c", "features.image_generation=true");
  if (!input.isRepo) argv.push("--skip-git-repo-check");
  // A cloned repository's own `.rules` is model-visible instruction from a
  // stranger, so it does not apply.
  if (input.caps.ignoreRules) argv.push("--ignore-rules");
  if (input.model) argv.push("--model", input.model);
  if (input.effort && input.effort !== "off") {
    argv.push("-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`);
  }
  if (input.mcp) argv.push(...codexMcpArgs("omp", input.mcp));
  // Exec-only options such as --sandbox must precede the resume subcommand.
  if (input.resumeToken) argv.push("resume", input.resumeToken);
  return argv;
}

/**
 * `-c` overrides adding one MCP server. Values are TOML: a JSON string is
 * a TOML basic string (the same escapes), and a JSON array of strings a
 * TOML array, so no path can break out into another key.
 */
export function codexMcpArgs(name: string, server: CodexMcpServer): string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`not an MCP server name: ${name}`);
  const key = `mcp_servers.${name}`;
  const args = [
    "-c",
    `${key}.command=${JSON.stringify(server.command)}`,
    "-c",
    `${key}.args=${JSON.stringify(server.args)}`,
  ];
  for (const [variable, value] of Object.entries(server.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) throw new Error(`not an environment variable: ${variable}`);
    args.push("-c", `${key}.env.${variable}=${JSON.stringify(value)}`);
  }
  args.push("-c", `${key}.tool_timeout_sec=${Math.ceil(server.toolTimeoutSec)}`);
  if (server.toolsApproval) args.push("-c", `${key}.default_tools_approval_mode=${JSON.stringify(server.toolsApproval)}`);
  return args;
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

/**
 * Codex's words for a plan's usage limit or quota, as 0.166.0 writes them
 * (read from its binary): "You’ve hit your usage limit. Upgrade to Plus …",
 * "… Visit https://chatgpt.com/settings/usage to purchase more credits",
 * "… for <model>. Switch to another model now", "Quota exceeded. Check your
 * plan and billing details.", "Your workspace is out of credits. …" and "You
 * hit your spend cap set in your workspace. …". The apostrophe is U+2019.
 * "To use Codex with your ChatGPT plan, upgrade to Plus" is not one: no reset
 * brings that plan back.
 */
const CODEX_LIMIT =
  /\bYou['’]ve hit your usage limit\b|\bQuota exceeded\. Check your plan\b|\bworkspace is out of credits\b|\bYou hit your spend cap\b/i;

/** Whether a failure's text says the subscription hit its limit. */
export function isCodexLimit(message: string): boolean {
  return CODEX_LIMIT.test(message);
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
  receiver_thread_ids?: string[];
  sender_thread_id?: string;
  prompt?: string;
  model?: string;
  agents_states?: Record<string, { status?: string; message?: string | null }>;
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
  readonly imagePaths = new Set<string>();
  /** Tool items announced by `item.started`, with when. */
  #started = new Map<string, number>();
  #completed = new Set<string>();
  readonly subagents: CodexSubagents;

  constructor(
    private readonly ctx: {
      projectId: string;
      threadId: string;
      turnId: string;
      workspace: string;
      now?: () => number;
    },
  ) { this.subagents = new CodexSubagents(ctx); }

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
    for (const path of rolloutImagePaths(line)) this.imagePaths.add(path);
    for (const path of rolloutImagePaths(line.item)) this.imagePaths.add(path);
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
        // A fatal error is printed twice, `error` and then `turn.failed`
        // with the same message: one failure, so the first one ends it.
        if (this.#closed) return [];
        this.#closed = true;
        const error =
          typeof line.error === "string"
            ? line.error
            : (line.error?.message ?? line.message ?? "codex reported an error");
        return [{ type: "agent.turn_failed", ...ids, error, ...(isCodexLimit(error) ? { limit: true as const } : {}) }];
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
    return [
      { type: "agent.turn_failed", ...ids, error: `codex exited with ${why}`, ...(isCodexLimit(why) ? { limit: true as const } : {}) },
    ];
  }

  #now(): number {
    return (this.ctx.now ?? Date.now)();
  }

  #item(phase: string, item: Item): DomainEvent[] {
    const ids = { threadId: this.ctx.threadId, turnId: this.ctx.turnId };
    const completed = phase === "item.completed";
    const id = item.id ?? "";

    switch (item.type) {
      case "collab_tool_call": {
        // A replayed completed tool is not a new task on a reusable worker.
        const lifecycle = this.#completed.has(id) ? [] : this.subagents.observe(item);
        return [
          ...this.#tool(phase, id, `codex:${item.tool ?? "collab"}`, { description: item.prompt ?? "Codex subagent", prompt: item.prompt ?? null, model: item.model ?? null }, () => ({ content: describe(item.agents_states), isError: item.status === "failed" })),
          ...lifecycle,
        ];
      }
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

      case "error": {
        const error = item.message ?? "codex reported an error";
        return [{ type: "agent.turn_failed", ...ids, error, ...(isCodexLimit(error) ? { limit: true as const } : {}) }];
      }

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
    if (this.#completed.has(id)) return events;
    if (!this.#started.has(id)) {
      this.#started.set(id, this.#now());
      events.push({ type: "agent.tool_use", ...ids, toolUseId: id, name, input });
    }
    if (phase !== "item.completed") return events;
    const startedAt = this.#started.get(id) ?? this.#now();
    this.#started.delete(id);
    this.#completed.add(id);
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

/** v2 workers must be addressed through the resumed parent, not exec resume on the child. */
export function codexSubagentPrompt(text: string, subagentId: string, parentSession: string | undefined): string {
  const prefix = `${parentSession}:`;
  const target = subagentId.startsWith(prefix) ? subagentId.slice(prefix.length) : "";
  if (!parentSession || !/^\/root(?:\/[a-zA-Z0-9_-]+)+$/.test(target)) throw new Error("This Codex subagent cannot be resumed from this parent session.");
  return [
    `The user is chatting directly with your existing native subagent ${JSON.stringify(target)} about its current task.`,
    "Use collaboration.followup_task to pass the user message below verbatim to that exact existing agent, then wait for its final response.",
    "The selected agent may answer questions or edit its current task in the existing workspace. Do not spawn a replacement, ask a sibling, answer for it, or do its edits yourself.",
    "If the selected agent is unavailable, report the delivery failure clearly. Do not silently substitute another agent.",
    "<subagent-user-message>", text, "</subagent-user-message>",
  ].join("\n\n");
}

export class CodexProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly label = "Codex";
  readonly models = CODEX_MODELS;
  listModels(ctx: RunContext): Promise<ProviderModel[]> {
    return listCodexModels(ctx, this.bin);
  }
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
    return withCodexImages(input, () => withCodexSubagents(input, runCli({
      provider: "codex",
      ctx: input.ctx,
      spec: {
        argv: codexArgv({
          bin: this.bin,
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
          isRepo: this.isRepo(input.ctx.cwd),
          caps,
          ...(input.codexMcp ? { mcp: input.codexMcp } : {}),
        }),
        stdin: `${CODEX_IMAGE_INSTRUCTIONS}\n\n${codexPrompt(input.subagentId ? codexSubagentPrompt(input.prompt, input.subagentId, input.resumeToken) : input.prompt, input.instructions, input.resumeToken)}`,
      },
      normaliser,
    }), normaliser.subagents, () => normaliser.sessionId), () => normaliser.sessionId, () => [...normaliser.imagePaths]);
  }
}
