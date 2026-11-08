import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexMcpServer } from "@ucch/providers";

/**
 * The OMP bridge as a Claude Code or Codex turn is given it (solution §10.3):
 * an MCP server the CLI starts with `node`, configured by its environment
 * alone (`packages/omp-bridge/src/config.ts` reads it).
 *
 * The environment is the bridge's, not the CLI's. The OpenRouter key every
 * bridge call is billed to goes here and nowhere else, so the CLI's own
 * environment keeps no API key (`forbiddenEnvPresent`) and the CLI stays on
 * its subscription; the bridge hands the key to the `omp` it starts, with
 * every other credential dropped (`ompEnv`).
 */
export interface BridgeServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BridgeServerInput {
  /** The `node` to run the bridge with: the server's own. */
  node: string;
  /** `OMP_BRIDGE_BIN`, the bundled `omp-bridge.mjs`. */
  bridgeBin: string;
  /** `OMP_BIN`. */
  ompBin: string;
  /**
   * OMP's own tools, and what they need: the subject's `omp/agent`
   * (`PI_CODING_AGENT_DIR`), this turn's bridge overlay (`writeOmpOverlay`)
   * and the OpenRouter key the calls bill. Null: the workspace has the OMP
   * bridge off, and the bridge offers `ucch_agent` alone.
   */
  omp: { agentDir: string; overlay: string; openrouterKey: string } | null;
  /** `ucch_agent` is offered: subagents on any harness (never to a subagent). */
  subagents: boolean;
  /** The worktree the CLI works in; every call runs there. */
  worktree: string;
  /** The server's scheduler socket and this turn's token for it (`BridgeLeases`). */
  schedulerSock: string;
  token: string;
  /** `OMP_BRIDGE_MAX_SECONDS`: `--max-time` for every call. */
  maxSeconds: number;
  /** Only a trusted project gets a language server or debugger (§0.3). */
  trusted: boolean;
  /** The overlay keeps the project's memory: `omp_recall` and `omp_retain` exist (§7.3). */
  memory: boolean;
}

export function bridgeServer(input: BridgeServerInput): BridgeServer {
  return {
    command: input.node,
    args: [input.bridgeBin],
    env: {
      UCCH_OMP_BIN: input.ompBin,
      ...(input.omp
        ? {
            UCCH_OMP_AGENT_DIR: input.omp.agentDir,
            UCCH_OMP_OVERLAY: input.omp.overlay,
            OPENROUTER_API_KEY: input.omp.openrouterKey,
          }
        : { UCCH_BRIDGE_OMP_TOOLS: "0" }),
      ...(input.subagents ? { UCCH_BRIDGE_SUBAGENTS: "1" } : {}),
      UCCH_WORKTREE: input.worktree,
      UCCH_SCHEDULER_SOCK: input.schedulerSock,
      UCCH_BRIDGE_TOKEN: input.token,
      UCCH_BRIDGE_MAX_SECONDS: String(input.maxSeconds),
      ...(input.trusted ? { UCCH_OMP_TRUSTED: "1" } : {}),
      ...(input.memory ? { UCCH_OMP_MEMORY: "1" } : {}),
    },
  };
}

/**
 * What one bridge call may take beyond `--max-time`, for the CLI's own
 * wait on the tool: the bridge's 35 s for a scheduler slot (`lease.ts`)
 * and its 30 s grace on the exchange (`call.ts`), plus a little.
 */
export const BRIDGE_CALL_OVERHEAD_SEC = 70;

/** How long a CLI waits on one `ucch_agent` call: the bridge's own hour (`SPAWN_WAIT_MS`). */
export const SUBAGENT_WAIT_SEC = 60 * 60;

/**
 * The bridge for one Codex turn. Codex takes its MCP servers as
 * `-c mcp_servers.omp.*` -- its own argv, which every user on the host can
 * read in `ps` -- so the environment goes in `<runDir>/<turnId>.bridge.json`
 * (0600), and the argv names only that file (`UCCH_BRIDGE_ENV_FILE`, read
 * by the bridge's `withEnvFile`). Codex waits up to `--max-time` plus the
 * bridge's overhead for a call; its own default is shorter than a call.
 */
export async function writeCodexBridge(
  runDir: string,
  turnId: string,
  server: BridgeServer,
  maxSeconds: number,
  /** A `ucch_agent` subagent runs a whole turn: Codex waits for it as long as Claude Code does. */
  subagents = false,
): Promise<{ mcp: CodexMcpServer; dispose(): Promise<void> }> {
  if (!/^[A-Za-z0-9-]+$/.test(turnId)) throw new Error(`not a turn id: ${turnId}`);
  const path = join(runDir, `${turnId}.bridge.json`);
  await writeFile(path, `${JSON.stringify(server.env, null, 2)}\n`, { mode: 0o600 });
  return {
    mcp: {
      command: server.command,
      args: server.args,
      env: { UCCH_BRIDGE_ENV_FILE: path },
      toolTimeoutSec: subagents ? Math.max(SUBAGENT_WAIT_SEC, maxSeconds + BRIDGE_CALL_OVERHEAD_SEC) : maxSeconds + BRIDGE_CALL_OVERHEAD_SEC,
      // `codex exec` asks no one: unapproved, every tool not marked
      // read-only is refused. Codex already acts unasked in its sandbox
      // (UCCH's permission modes do not reach it), and so do these.
      toolsApproval: "approve",
    },
    dispose: () => rm(path, { force: true }),
  };
}

/**
 * Writes Claude Code's `--mcp-config` for one turn to
 * `<runDir>/<turnId>.mcp.json`, mode 0600, and returns its path and a
 * disposer that deletes it. `runDir` is the subject's `claude/run`
 * (`ProviderService.cliRunDir`); the file holds the OpenRouter key.
 */
export async function writeClaudeMcpConfig(
  runDir: string,
  turnId: string,
  server: BridgeServer,
): Promise<{ path: string; dispose(): Promise<void> }> {
  if (!/^[A-Za-z0-9-]+$/.test(turnId)) throw new Error(`not a turn id: ${turnId}`);
  const path = join(runDir, `${turnId}.mcp.json`);
  await writeFile(path, `${JSON.stringify({ mcpServers: { omp: server } }, null, 2)}\n`, { mode: 0o600 });
  return { path, dispose: () => rm(path, { force: true }) };
}
