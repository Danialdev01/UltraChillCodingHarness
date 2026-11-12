import { readFileSync } from "node:fs";
import { forbiddenEnvFor, isOmpCredentialEnv } from "@ucch/providers";

/**
 * What the bridge is told, all of it by the environment the server writes
 * into the CLI's MCP config (solution §10.1). The CLI starts the bridge with
 * that environment; nothing else configures it.
 */
export interface BridgeConfig {
  /** The `omp` to run. `UCCH_OMP_BIN`, else `omp` on the PATH. */
  ompBin: string;
  /** The subject's `omp/agent` (`PI_CODING_AGENT_DIR`). Unset: OMP's own default. */
  agentDir: string | null;
  /** The bridge overlay passed with `--config`. */
  overlay: string | null;
  /** The workspace's OpenRouter key, which every bridge call is billed to. */
  openrouterKey: string | null;
  /** The worktree the calling CLI works in; OMP runs there. Unset: the bridge's cwd. */
  worktree: string;
  /** `--max-time` for every call, in seconds. */
  maxSeconds: number;
  /**
   * The workspace keeps OMP memory (`UCCH_OMP_MEMORY=1`): `recall` and
   * `retain` exist only then. OMP refuses to start when `--tools` names a
   * tool the session does not have (18.14.1: "Built-in tools unavailable in
   * this session"), so the bridge has to know.
   */
  memory: boolean;
  /** OMP's own `web_search` has a search key (`UCCH_OMP_WEB_SEARCH=1`); likewise. */
  webSearch: boolean;
  /**
   * The project is trusted (`UCCH_OMP_TRUSTED=1`, solution §0.3): only then
   * may a call start a language server or a debugger. A cloned
   * repository's `lsp.json` / `.omp/lsp.json` is an arbitrary command that
   * loads unless `--no-lsp`, and its `dap.json` loads under every flag, so
   * an untrusted project's calls run `--no-lsp` and have no `lsp` or
   * `debug` -- which OMP then does not have at all (`--tools lsp` with
   * `--no-lsp` fails to start, 18.14.1).
   */
  trusted: boolean;
  /**
   * The server's scheduler socket (`UCCH_SCHEDULER_SOCK`), where every call
   * takes an OMP slot first (solution §10.5). Unset -- a bridge someone
   * added to their own Claude Code -- there is no server to ask.
   */
  schedulerSock: string | null;
  /** The turn's lease token (`UCCH_BRIDGE_TOKEN`), which the socket asks for. */
  leaseToken: string | null;
  /**
   * OMP calls this bridge makes before it refuses more
   * (`UCCH_BRIDGE_MAX_CALLS`). The CLI starts one bridge per turn, so this
   * is the turn's budget.
   */
  maxCalls: number;
  /**
   * OMP's own tools are offered (`UCCH_BRIDGE_OMP_TOOLS`, on unless "0"):
   * the workspace turned the OMP bridge on. Off, the bridge is there only
   * for `ucch_agent`, and starts no `omp` at all.
   */
  ompTools: boolean;
  /**
   * `ucch_agent` is offered (`UCCH_BRIDGE_SUBAGENTS=1`): subagents on any
   * harness, run by the server over the scheduler socket. Never for a
   * subagent's own turn, which does not start subagents.
   */
  subagents: boolean;
  messaging?: boolean;
  /**
   * `show_widget` is offered (`UCCH_WIDGETS=1`): the workspace allows
   * interactive widgets. It runs nothing; the chat draws the call's input.
   */
  widgets: boolean;
}

/**
 * The environment with `UCCH_BRIDGE_ENV_FILE` read into it: a JSON object
 * of variables the server wrote to a 0600 file for the turn. Codex is told
 * its MCP servers' environment with `-c mcp_servers.omp.env.X=…`, which is
 * its own argv -- readable by every user on the host in `ps` -- so a Codex
 * turn's config passes only this path, and the key travels in the file
 * (solution §10.3). The file's variables win over the environment's.
 */
export function withEnvFile(env: NodeJS.ProcessEnv, read: (path: string) => string = (path) => readFileSync(path, "utf8")): NodeJS.ProcessEnv {
  const path = env.UCCH_BRIDGE_ENV_FILE;
  if (!path) return env;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(path));
  } catch (error) {
    throw new Error(`UCCH_BRIDGE_ENV_FILE (${path}) could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((value) => typeof value !== "string")) {
    throw new Error(`UCCH_BRIDGE_ENV_FILE (${path}) is not an object of strings`);
  }
  return { ...env, ...(parsed as Record<string, string>) };
}

const DEFAULT_MAX_SECONDS = 300;
const DEFAULT_MAX_CALLS = 12;

export function readBridgeConfig(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): BridgeConfig {
  const set = (name: string) => (env[name] ? env[name]! : null);
  const seconds = Number(env.UCCH_BRIDGE_MAX_SECONDS);
  const calls = Number(env.UCCH_BRIDGE_MAX_CALLS);
  return {
    ompBin: set("UCCH_OMP_BIN") ?? "omp",
    agentDir: set("UCCH_OMP_AGENT_DIR"),
    overlay: set("UCCH_OMP_OVERLAY"),
    openrouterKey: set("OPENROUTER_API_KEY"),
    worktree: set("UCCH_WORKTREE") ?? cwd,
    maxSeconds: Number.isInteger(seconds) && seconds > 0 ? seconds : DEFAULT_MAX_SECONDS,
    memory: env.UCCH_OMP_MEMORY === "1",
    webSearch: env.UCCH_OMP_WEB_SEARCH === "1",
    trusted: env.UCCH_OMP_TRUSTED === "1",
    schedulerSock: set("UCCH_SCHEDULER_SOCK"),
    leaseToken: set("UCCH_BRIDGE_TOKEN"),
    maxCalls: env.UCCH_BRIDGE_MAX_CALLS !== undefined && Number.isInteger(calls) && calls >= 0 ? calls : DEFAULT_MAX_CALLS,
    ompTools: env.UCCH_BRIDGE_OMP_TOOLS !== "0",
    subagents: env.UCCH_BRIDGE_SUBAGENTS === "1",
    messaging: env.UCCH_BRIDGE_MESSAGING === "1",
    widgets: env.UCCH_WIDGETS === "1",
  };
}

/**
 * The environment an `omp` the bridge starts gets: the bridge's own, which
 * is the CLI's plus the MCP config's, with every variable OMP would read as
 * a credential dropped, and then the workspace's OpenRouter key alone put
 * back -- as `providerEnv` builds it for an OMP turn. A key the CLI's
 * environment happened to carry (an operator's `ANTHROPIC_API_KEY`, an AWS
 * role) never reaches OMP, so a bridge call is billed to the workspace's
 * key or not at all.
 *
 * The bridge's own `UCCH_*` settings stay behind: they are its, not OMP's.
 */
export function ompEnv(config: BridgeConfig, parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || isOmpCredentialEnv(name) || name.startsWith("UCCH_")) continue;
    env[name] = value;
  }
  env.TERM = "dumb";
  env.CI = "1";
  env.OMP_SKIP_SETUP = "1";
  if (config.agentDir) env.PI_CODING_AGENT_DIR = config.agentDir;
  if (config.openrouterKey) env.OPENROUTER_API_KEY = config.openrouterKey;
  return env;
}

/**
 * Refuses an environment that could bill OMP to anything but the
 * workspace's key: the same rule an OMP turn's start keeps
 * (`forbiddenEnvFor`). `ompEnv` already leaves such variables out; this is
 * the check that holds if it ever stops doing so.
 */
export function refuseForeignCredentials(env: Record<string, string>): string | null {
  const name = forbiddenEnvFor("omp", env);
  return name ? `refusing to start omp: ${name} is set, and a bridge call is billed to the workspace's OpenRouter key only` : null;
}
