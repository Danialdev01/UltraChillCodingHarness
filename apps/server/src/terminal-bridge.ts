import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { projects, users, workspaces, type Database } from "@ucch/db";
import { readAgentSettings, type WorkspaceAgentSettings } from "@ucch/protocol";
import { codexMcpArgs } from "@ucch/providers";
import { decryptSecret } from "./crypto.js";
import { BRIDGE_CALL_OVERHEAD_SEC, bridgeServer } from "./omp-bridge-config.js";
import { DEFAULT_OMP_SETTINGS, writeOmpOverlay } from "./omp-overlay.js";
import { resolveModel, type OmpBridgeOptions } from "./agent.js";
import { workspaceOfSubject } from "./providers.js";

/**
 * The OMP bridge for `claude` and `codex` started by hand in a project
 * terminal (solution §10.3, OM6.7).
 *
 * The shell is given `UCCH_OMP_MCP`, a path, when it starts: `#open` in
 * `terminals.ts` is synchronous, and whether the workspace has the bridge
 * on is a database read. So the path is fixed first and the files are
 * written just after, only when the bridge is on and there is a key to
 * bill. The wrappers in `shell/ucch.bashrc` and `ucch.fish` add the flags
 * only while the file is there, so a terminal without the bridge runs the
 * CLIs exactly as before.
 *
 * Beside `<subject>/omp/run/term-<terminalId>.mcp.json` (Claude Code's
 * `--mcp-config`) are `.codex` (Codex's `-c` arguments, one per line) and
 * `.bridge.json`, the bridge's environment with the OpenRouter key, which
 * both name with `UCCH_BRIDGE_ENV_FILE` so the key is in one 0600 file and
 * never in an argv. All of it, the overlay and the scheduler token go when
 * the terminal closes.
 *
 * A CLI started by hand asks its person itself, so nothing is pre-allowed
 * or pre-approved here.
 */

/** What decides a terminal's bridge, read when it opens. */
export interface TerminalBridgeFacts {
  enabled: boolean;
  openrouterKeyEncrypted: string | null;
  defaultModel: string | null;
  /** The workspace's memory setting: the bridge recalls from and retains to the project's bank (OM7.2). */
  memory: WorkspaceAgentSettings["memory"];
  /** The project is trusted (`projects.omp_trusted`): its calls get `lsp` and `debug` (§0.3). */
  trusted: boolean;
}

export interface TerminalBridgeOptions extends OmpBridgeOptions {
  secretKey: string | undefined;
  /** As `AgentOptions.onKeyUsed`: the ciphertext of a key just decrypted. */
  onKeyUsed?: (encrypted: string) => void;
  /** `DEFAULT_MODEL`, for a person with none of their own. */
  defaultModel: string;
  /** The subject's `omp/run` and `omp/agent` (`ProviderService`). */
  runDir(subject: string): string;
  agentDir(subject: string): string;
  /** The project's mnemopi bank under the subject (`ProviderService.ompMemoryDb`). */
  memoryDb(subject: string, projectId: string): string;
  /** The workspace's setting, and the subject's key and the person's model. */
  facts(projectId: string, subject: string, userId: string): Promise<TerminalBridgeFacts | null>;
}

export class TerminalBridge {
  readonly #options: TerminalBridgeOptions;

  constructor(options: TerminalBridgeOptions) {
    this.#options = options;
  }

  /** The terminal's `UCCH_OMP_MCP`. Synchronous: the shell's environment needs it before it starts. */
  path(subject: string, terminalId: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(terminalId)) throw new Error(`not a terminal id: ${terminalId}`);
    return join(this.#options.runDir(subject), `term-${terminalId}.mcp.json`);
  }

  /**
   * Writes the terminal's bridge, or nothing (null) when the workspace has
   * it off or there is no key. Never throws for those; a failure to write
   * is the caller's to hear.
   */
  async open(input: {
    projectId: string;
    subject: string;
    userId: string;
    terminalId: string;
    cwd: string;
  }): Promise<{ dispose(): Promise<void> } | null> {
    const options = this.#options;
    const facts = await options.facts(input.projectId, input.subject, input.userId);
    if (!facts?.enabled || !facts.openrouterKeyEncrypted || !options.secretKey) return null;
    const openrouterKey = decryptSecret(facts.openrouterKeyEncrypted, options.secretKey);
    options.onKeyUsed?.(facts.openrouterKeyEncrypted);

    const mcpPath = this.path(input.subject, input.terminalId);
    const base = mcpPath.slice(0, -".mcp.json".length);
    const disposers: (() => Promise<void> | void)[] = [];
    const dispose = async () => {
      for (const step of disposers.splice(0).reverse()) await step();
    };
    try {
      const overlay = await writeOmpOverlay(options.runDir(input.subject), `bridge-term-${input.terminalId}`, {
        settings: {
          ...DEFAULT_OMP_SETTINGS,
          models: { default: resolveModel(undefined, facts.defaultModel, options.defaultModel) },
          memory: facts.memory,
        },
        ...(facts.memory.enabled ? { memoryDbPath: options.memoryDb(input.subject, input.projectId), memoryToolsOnly: true } : {}),
        preset: "standard",
        // The bridge's own `omp` is headless; the CLI asked its person first.
        permissionMode: "allow_all",
        trusted: facts.trusted,
        workersPerTurn: 2,
        webSearch: false,
      });
      disposers.push(() => overlay.dispose());
      const lease = options.leases.register({ ownerId: input.subject, threadId: `terminal:${input.terminalId}` });
      disposers.push(() => lease.revoke());
      const server = bridgeServer({
        node: process.execPath,
        bridgeBin: options.bin,
        ompBin: options.ompBin,
        agentDir: options.agentDir(input.subject),
        overlay: overlay.path,
        openrouterKey,
        worktree: input.cwd,
        schedulerSock: options.socket,
        token: lease.token,
        maxSeconds: options.maxSeconds,
        trusted: facts.trusted,
        memory: facts.memory.enabled,
      });
      const envFile = `${base}.bridge.json`;
      const visible = { UCCH_BRIDGE_ENV_FILE: envFile };
      const codexArgs = codexMcpArgs("omp", {
        command: server.command,
        args: server.args,
        env: visible,
        toolTimeoutSec: options.maxSeconds + BRIDGE_CALL_OVERHEAD_SEC,
      });
      // One argument per line for the wrappers to read back.
      if (codexArgs.some((arg) => arg.includes("\n"))) throw new Error("a bridge path has a newline in it");
      for (const [path, content] of [
        [envFile, `${JSON.stringify(server.env, null, 2)}\n`],
        [`${base}.codex`, `${codexArgs.join("\n")}\n`],
        // Last: the wrappers take this file's presence as "the bridge is ready".
        [mcpPath, `${JSON.stringify({ mcpServers: { omp: { command: server.command, args: server.args, env: visible } } }, null, 2)}\n`],
      ] as const) {
        disposers.push(() => rm(path, { force: true }));
        await writeFile(`${path}.tmp`, content, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      }
      return { dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  }
}

/**
 * `TerminalBridgeOptions.facts` from the database: the project's workspace
 * setting; the workspace's OpenRouter key for a workspace subject, else the
 * person's; the person's own default model.
 */
export function terminalBridgeFacts(db: Database): TerminalBridgeOptions["facts"] {
  return async (projectId, subject, userId) => {
    const [project] = await db
      .select({
        agent: workspaces.agentSettings,
        workspaceId: workspaces.id,
        workspaceKey: workspaces.openrouterKeyEncrypted,
        trusted: projects.ompTrusted,
      })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return null;
    const [person] = await db
      .select({ key: users.openrouterKeyEncrypted, defaultModel: users.defaultModel })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!person) return null;
    const workspace = workspaceOfSubject(subject);
    // A workspace subject is only ever this project's own workspace.
    if (workspace && workspace !== project.workspaceId) return null;
    const settings = readAgentSettings(project.agent);
    return {
      enabled: settings.ompBridge.enabled,
      memory: settings.memory,
      trusted: project.trusted === true,
      openrouterKeyEncrypted: workspace ? project.workspaceKey : person.key,
      defaultModel: person.defaultModel,
    };
  };
}
