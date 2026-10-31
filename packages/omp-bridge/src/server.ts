import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProcessHost } from "@ucch/providers";
import { ompEnv, refuseForeignCredentials, type BridgeConfig } from "./config.js";

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

  server.registerTool(
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

  return server;
}

function failure(reason: string): CallToolResult {
  return { content: [{ type: "text", text: reason }], isError: true };
}
