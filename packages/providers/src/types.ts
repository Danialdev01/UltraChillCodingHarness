import type {
  AgentPermissionMode,
  CliProviderId,
  DomainEvent,
  ReasoningEffort,
} from "@ucch/protocol";
import { isOmpCredentialEnv } from "./omp-credentials.js";
import type { OmpHostToolSpec } from "./omp-rpc-types.js";
import type { ProcessHost } from "./process.js";

/**
 * The provider boundary.
 *
 * One interface, two CLI implementations, and the server orchestrator only
 * ever sees the interface. The native loop is not behind it: it is a
 * function call in-process (`@ucch/agent`), not a process to supervise, and
 * forcing it through a process-shaped seam would be pretence.
 *
 * Every provider normalises into the harness's existing event vocabulary.
 * That is the load-bearing decision in the whole feature: if the browser
 * had to know which provider produced an event the UI would fork, the
 * revert logic would fork, and there would be three harnesses to maintain.
 */

export interface ProviderHealth {
  installed: boolean;
  authenticated: boolean;
  /**
   * `subscription` is the vendor's own login; `token` is a pasted
   * `setup-token`. What `api-key` means is the provider's: for Claude Code
   * and Codex it means the CLI would bill an API key it found, which is the
   * state this feature exists to avoid and is reported so the settings page
   * can say so; for OMP it is the workspace's OpenRouter key, the intended
   * route.
   */
  authMode: "subscription" | "token" | "api-key" | "none";
  /** Display only -- a masked email, never a token. */
  account?: string;
  version?: string;
  expiresAt?: string;
  error?: string;
  /** Things the person should read before enabling this provider. */
  warnings?: string[];
}

/**
 * Where and how a process runs. Composed by the server -- the working
 * directory, the credential directory variables, the scrubbed environment --
 * and handed in whole. The package adds nothing to `env` and reads nothing
 * from the real one.
 */
export interface RunContext {
  cwd: string;
  env: Record<string, string>;
  host: ProcessHost;
}

export interface ProviderRunInput {
  /** Continue this native worker through its owning harness session. */
  subagentId?: string;
  /** Claude Code: the agentId that worker is continued by (`SendMessage`). */
  subagentHandle?: string;
  ctx: RunContext;
  prompt: string;
  projectId: string;
  threadId: string;
  turnId: string;
  /** The provider's own session id from a previous turn, to resume. */
  resumeToken?: string;
  model?: string;
  /**
   * How hard the model thinks. `off` and absent both mean the CLI's own
   * default. A provider that has no such setting ignores it.
   */
  effort?: ReasoningEffort;
  /** How much the CLI may do unasked. A provider that cannot ask ignores it. */
  permissionMode?: AgentPermissionMode;
  /**
   * The project's `.agent/` knowledge, as the native loop is given it. Each
   * provider hands it to its model the way its CLI allows: Claude Code as an
   * appended system prompt, Codex ahead of a new session's first message.
   */
  instructions?: string;
  /**
   * Claude Code: the turn's MCP config, which offers the OMP bridge
   * (solution §10.3). Written 0600 by the server and deleted after the
   * turn; the bridge's environment, the OpenRouter key with it, is in the
   * file and never in the CLI's own.
   */
  mcpConfigPath?: string;
  /**
   * Codex: the OMP bridge as an MCP server, passed as
   * `-c mcp_servers.omp.*` (solution §10.3). Its `env` is argv, so it holds
   * nothing secret: the key is in the file `UCCH_BRIDGE_ENV_FILE` names.
   */
  codexMcp?: CodexMcpServer;
  /** What only an OMP run takes; the server writes and owns all of it. */
  omp?: OmpRunFiles;
  /**
   * The harness's own tools, offered to an OMP run as host tools
   * (solution §3.7). Absent or empty, none are offered.
   */
  hostTools?: readonly HostToolSpec[];
  /**
   * Runs one call to a host tool and resolves with its result; never
   * rejects for a tool's own failure. `signal` aborts when the provider
   * cancels the call. Required whenever `hostTools` is not empty.
   */
  onHostToolCall?(call: HostToolCall, signal: AbortSignal): Promise<HostToolResult>;
}

/** One MCP server for Codex's `-c mcp_servers.<name>.*` (OM0 confirmed the syntax). */
export interface CodexMcpServer {
  command: string;
  args: readonly string[];
  /** Visible in `ps`: paths and switches only, never a key. */
  env: Readonly<Record<string, string>>;
  /** How long Codex waits for one call before it gives up on it. */
  toolTimeoutSec: number;
  /**
   * `default_tools_approval_mode` (0.166.0: `auto`, `prompt`, `writes`,
   * `approve`). `codex exec` cannot ask, and refuses a tool not marked
   * read-only unless it is pre-approved ("MCP tool call requires approval,
   * but approval policy is never").
   */
  toolsApproval?: "auto" | "prompt" | "writes" | "approve";
}

/** A host tool as the model is offered it: JSON Schema parameters. */
export type HostToolSpec = OmpHostToolSpec;

/** One call the model made to a host tool. */
export interface HostToolCall {
  /** The provider's id for the call, to answer it by. */
  id: string;
  /** The model's tool call id: what the call's `agent.tool_use` carries. */
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface HostToolResult {
  content: string;
  isError: boolean;
}

/** The files an OMP turn runs with (solution §3.1). Absolute paths. */
export interface OmpRunFiles {
  /** This turn's overlay (§4), passed with `--config`. */
  overlayPath: string;
  /** The project's session directory, `<creds>/omp/sessions/<projectId>`. */
  sessionDir: string;
  /** The UCCH guard hook (§3.9), passed with `--hook`. */
  guardHookPath: string;
  /** Whether the workspace is trusted (§0.3); an untrusted one runs with `--no-lsp`. */
  trusted: boolean;
  /** OMP's own limit on the session, e.g. "45m". */
  maxTime?: string;
  /**
   * Where the overlay starts compaction, for `context.usage`: OMP's stats
   * do not say (solution §5.2). Absent or empty, the threshold is unknown.
   */
  contextThreshold?: { tokens?: number; percent?: number };
}

/** What a person said to a CLI's permission prompt. */
export interface PermissionReply {
  behavior: "allow" | "deny";
  /** Handed to the model as the tool's error on a deny. */
  message?: string;
}

export interface AgentRun {
  /** Normalised events, in order. Ends when the process has exited. */
  events: AsyncIterable<DomainEvent>;
  /**
   * Answers an `agent.permission_requested` this run emitted. False when the
   * request is unknown or already answered -- a stale click, not an error.
   * Absent on a provider that never asks.
   */
  answerPermission?(requestId: string, reply: PermissionReply): boolean;
  /** End the turn cleanly: SIGINT, and the CLI records what it managed. */
  interrupt(): Promise<void>;
  /** Hard stop: SIGTERM, then SIGKILL. For teardown, not for a stop button. */
  kill(): Promise<void>;
}

export interface ProviderModel {
  id: string;
  name: string;
  /**
   * The effort levels this model takes, lowest first. Absent when the
   * provider passes none on, and the composer then offers no effort control.
   */
  efforts?: readonly ReasoningEffort[];
}

/** A plan's usage windows, 0-100, as the CLI reported them. */
export interface ProviderRateLimits {
  windows: { id: "session" | "weekly"; usedPercent: number; resetsAt: string | null; minutes?: number }[];
  /** The CLI says the plan's limit is reached. */
  limited: boolean;
}

export interface AgentProvider {
  readonly id: CliProviderId;
  readonly label: string;
  /** Default choices when the provider does not expose a live catalogue. */
  readonly models: readonly ProviderModel[];
  /** Discover the catalogue using this account's CLI environment. */
  listModels?(ctx: RunContext): Promise<readonly ProviderModel[]>;
  /** Is this provider usable in this context for this user right now? */
  probe(ctx: RunContext): Promise<ProviderHealth>;
  /**
   * The account's plan usage, asked of the CLI itself (never of the vendor
   * with the login's token). Absent: the CLI has no way to say outside a
   * turn, and the reading comes from the turn's own stream instead.
   */
  rateLimits?(ctx: RunContext): Promise<ProviderRateLimits>;
  /** Start or resume a turn. */
  run(input: ProviderRunInput): AgentRun;
}

/**
 * Variables that would silently move a run onto API billing.
 *
 * Auth precedence in both CLIs puts an API key above a subscription login,
 * and in non-interactive mode the key is used without a prompt. A stray key
 * in the environment is therefore not a configuration detail but the exact
 * failure this feature exists to prevent, so a run refuses to start with one
 * present rather than quietly charging someone's card.
 */
export const FORBIDDEN_ENV = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;

export function forbiddenEnvPresent(env: Record<string, string>): string | null {
  for (const name of FORBIDDEN_ENV) if (name in env) return name;
  return null;
}

/**
 * The credential variables each provider's process may hold.
 *
 * The CLIs hold none: they bill a subscription login, and a key would
 * outrank it. OMP is the opposite case -- it bills the workspace's
 * OpenRouter key, handed over in `OPENROUTER_API_KEY` -- so for it the rule
 * is not "these three are forbidden" but "this one is allowed": every other
 * variable OMP would read as a credential refuses the run (`omp-credentials.ts`).
 */
export const ALLOWED_CREDENTIAL_ENV: Record<CliProviderId, readonly string[]> = {
  claude: [],
  codex: [],
  omp: ["OPENROUTER_API_KEY"],
};

/** The first variable in `env` that `id`'s process must not have, or null. */
export function forbiddenEnvFor(id: CliProviderId, env: Record<string, string>): string | null {
  if (id !== "omp") return forbiddenEnvPresent(env);
  const allowed = ALLOWED_CREDENTIAL_ENV.omp;
  for (const name of Object.keys(env)) {
    if (isOmpCredentialEnv(name) && !allowed.includes(name)) return name;
  }
  return null;
}
