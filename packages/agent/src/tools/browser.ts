import { BROWSER_TOOLS, type BrowserToolSpec } from "@ucch/browser/tools";
import { defineTool, type AnyTool, type ToolResult } from "../tool.js";

/**
 * The browser tools (`@ucch/browser/tools` has the specs): each forwards to
 * the turn's bound browser, which validates again, takes the tab's lock and
 * runs the operation in the server's Chromium.
 */
function browserTool(spec: BrowserToolSpec): AnyTool {
  return defineTool({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.schema,
    permission: spec.permission,
    // A page load or a full-page capture is slow; a hung one is not.
    timeoutMs: 120_000,
    async run(input, ctx): Promise<ToolResult> {
      if (!ctx.browser) return { content: "The browser is not available on this server.", isError: true };
      const result = await ctx.browser.call(spec.name, input, ctx.signal);
      return {
        content: result.text,
        ...(result.isError ? { isError: true } : {}),
        ...(result.images?.length ? { images: result.images } : {}),
        display: { title: spec.name.replace("browser_", "") },
      };
    },
  });
}

export const browserTools: readonly AnyTool[] = BROWSER_TOOLS.map(browserTool);
