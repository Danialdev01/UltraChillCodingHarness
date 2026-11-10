import { WIDGET_MAX_BYTES } from "@ucch/protocol/plain";
import { z } from "zod/v4";
import { defineTool, type ToolResult } from "../tool.js";

/**
 * `show_widget`: an interactive visual drawn inline in the chat.
 *
 * The tool does nothing on the server. The call's input is stored with the
 * turn like any other, and the chat draws the widget from it (see
 * `@ucch/protocol` widgets.ts) -- so it renders the same on reload, and the
 * result the model sees is just that it was shown.
 */
export const showWidget = defineTool({
  name: "show_widget",
  description:
    "Render an interactive visual inline in the chat: a calculator, a chart of numbers, a process or architecture diagram, a comparison. " +
    "widget_code is an HTML fragment (no <html>, <head> or <body>) with inline <style> and <script>, or a raw <svg>. " +
    "Follow the widget rules in your instructions: self-contained, libraries only from https://cdn.jsdelivr.net, no network calls, colours from the theme CSS variables. " +
    "Put explanatory text in your reply, not in the widget.",
  permission: "read",
  inputSchema: z.strictObject({
    title: z.string().describe("snake_case name, used as the heading and the download file name, e.g. hosting_cost_calculator."),
    widget_code: z.string().describe("The HTML fragment or SVG."),
    loading_messages: z
      .array(z.string())
      .nullable()
      .describe("A few short messages shown while the widget is being built. Null for the default."),
  }),
  async run(input): Promise<ToolResult> {
    if (!input.widget_code.trim()) return { content: "widget_code is empty.", isError: true };
    if (new TextEncoder().encode(input.widget_code).length > WIDGET_MAX_BYTES) {
      return {
        content: `widget_code is over ${WIDGET_MAX_BYTES} bytes, so it would be shown as code rather than run. Make it smaller.`,
        isError: true,
      };
    }
    return { content: JSON.stringify({ ok: true }), display: { title: input.title } };
  },
});
