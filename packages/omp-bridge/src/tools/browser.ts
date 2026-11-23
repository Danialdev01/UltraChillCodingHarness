import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BROWSER_TOOLS } from "@ucch/browser/tools";
import type { BridgeConfig } from "../config.js";
import { callBrowser } from "../spawn.js";

/**
 * The shared browser's tools, offered to Claude Code and Codex. The specs
 * are `@ucch/browser`'s, the same ones a native turn and an OMP turn are
 * given; each call is run by the server, in its Chromium, as this turn's
 * session. Screenshots come back as MCP image content, which both CLIs
 * show their model.
 *
 * Not behind the bridge's OMP call budget (`callGate`): a browser call
 * starts no `omp` and costs nothing but time.
 */
export function registerBrowserTools(server: McpServer, config: BridgeConfig): void {
  for (const spec of BROWSER_TOOLS) {
    server.registerTool(
      spec.name,
      {
        description: spec.description,
        inputSchema: spec.schema.shape,
        annotations: { readOnlyHint: spec.permission === "read", openWorldHint: true },
      },
      async (input: unknown, extra: { signal?: AbortSignal }): Promise<CallToolResult> => {
        const outcome = await callBrowser(config, spec.name, (input ?? {}) as Record<string, unknown>, extra.signal ? { signal: extra.signal } : {});
        return {
          content: [
            { type: "text", text: outcome.text || "(no output)" },
            ...(outcome.images ?? []).map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mediaType })),
          ],
          ...(outcome.isError ? { isError: true } : {}),
        };
      },
    );
  }
}
