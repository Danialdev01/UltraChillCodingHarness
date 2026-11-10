import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProcessHost } from "@ucch/providers";
import { failure } from "./call.js";
import { ompEnv, refuseForeignCredentials, type BridgeConfig } from "./config.js";
import { callGate } from "./lease.js";
import { ucchAgent } from "./tools/agent.js";
import { BRIDGE_TOOLS } from "./tools/index.js";
import { showWidget } from "./tools/widget.js";

/**
 * The bridge as an MCP server: OMP's tools, offered to Claude Code and Codex
 * (solution §10). Transport-free, so a test talks to it in memory and
 * `index.ts` puts it on stdio.
 *
 * Every tool answers; none throws. A failure is a result with `isError` and
 * a one-line reason, which the calling CLI shows its model like any other
 * tool error (§10.2).
 */
export function createBridgeServer(config: BridgeConfig, host: ProcessHost, parentEnv: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer({ name: "omp", version: "0.0.0" });

  // OMP's tools only where the workspace turned the bridge on; `ucch_agent`
  // only where the turn may start subagents; `show_widget` where the
  // workspace allows widgets. Any of them can be the only one.
  const tools = [
    ...(config.ompTools ? BRIDGE_TOOLS : []),
    ...(config.subagents ? [ucchAgent] : []),
    ...(config.widgets ? [showWidget] : []),
  ];

  if (config.ompTools) server.registerTool(
    "omp_ping",
    {
      description: "Checks that the OMP bridge can start OMP: answers with the installed omp version.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const env = ompEnv(config, parentEnv);
      const refused = refuseForeignCredentials(env);
      if (refused) return failure(refused);
      try {
        const result = await host.run({ argv: [config.ompBin, "--version"], cwd: config.worktree, env }, { timeoutMs: 15_000 });
        const version = result.stdout.trim();
        if (result.code !== 0 || !version) {
          return failure(`omp --version failed: ${(result.stderr.trim() || `exit ${result.code ?? result.signal}`).split("\n")[0]}`);
        }
        return { content: [{ type: "text", text: version }] };
      } catch (error) {
        return failure(`could not start omp (${config.ompBin}): ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  // One gate per bridge, which is one per CLI turn: the turn's budget.
  const ctx = { config, host, parentEnv, gate: callGate(config) };
  for (const definition of tools) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.inputSchema, annotations: definition.annotations },
      async (input: unknown): Promise<CallToolResult> => {
        try {
          return await definition.run(input as never, ctx);
        } catch (error) {
          // Never thrown to the CLI: a tool error, with one line.
          return failure(`${definition.name} failed: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
        }
      },
    );
  }

  return server;
}
