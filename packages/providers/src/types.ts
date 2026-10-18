import type {
  AgentPermissionMode,
  CliProviderId,
  DomainEvent,
  ReasoningEffort,
} from "@ucch/protocol";
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
   * `setup-token`; `api-key` means the CLI would bill an API key it found,
   * which is the state this feature exists to avoid and is reported so the
   * settings page can say so.
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
   * The project's `.ucch/` knowledge, as the native loop is given it. Each
   * provider hands it to its model the way its CLI allows: Claude Code as an
   * appended system prompt, Codex ahead of a new session's first message.
   */
  instructions?: string;
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

export interface AgentProvider {
  readonly id: CliProviderId;
  readonly label: string;
  /** What the composer offers. Static: the CLIs own their catalogues. */
  readonly models: readonly ProviderModel[];
  /** Is this provider usable in this context for this user right now? */
  probe(ctx: RunContext): Promise<ProviderHealth>;
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
