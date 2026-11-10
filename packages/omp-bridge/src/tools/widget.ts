import { SHOW_WIDGET_TOOL, WIDGET_MAX_BYTES } from "@ucch/protocol/plain";
import { z } from "zod";
import { failure } from "../call.js";
import { tool } from "./tool.js";

/**
 * `show_widget` for Claude Code and Codex: the built-in agent's tool of the
 * same name (`packages/agent/src/tools/widget.ts`). The bridge does nothing
 * with it -- the call's input is in the turn's log, and the chat draws the
 * widget from that -- so it runs no `omp`, takes no lease and bills nothing.
 */
export const showWidget = tool({
  name: SHOW_WIDGET_TOOL,
  description:
    "Render an interactive visual inline in the UCCH chat: a calculator, a chart of numbers, a process or architecture diagram, a comparison. " +
    "widget_code is an HTML fragment (no <html>, <head> or <body>) with inline <style> and <script>, or a raw <svg>. " +
    "Follow the widget rules in your instructions: self-contained, libraries only from https://cdn.jsdelivr.net, no network calls, colours from the theme CSS variables. " +
    "Put explanatory text in your reply, not in the widget.",
  inputSchema: {
    title: z.string().min(1).max(120).describe("snake_case name, e.g. hosting_cost_calculator."),
    widget_code: z.string().min(1).describe("The HTML fragment or SVG."),
    loading_messages: z.array(z.string()).max(10).optional().describe("Short messages shown while it is built."),
  },
  annotations: { title: "Show widget", readOnlyHint: true, openWorldHint: false },
  run: async ({ widget_code }) => {
    if (Buffer.byteLength(widget_code, "utf8") > WIDGET_MAX_BYTES) {
      return failure(`widget_code is over ${WIDGET_MAX_BYTES} bytes, so it would be shown as code rather than run. Make it smaller.`);
    }
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  },
});
