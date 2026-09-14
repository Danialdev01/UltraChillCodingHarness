import { z } from "zod/v4";
import { ExecInterruptedError } from "../executor.js";
import { defineTool, type ToolResult } from "../tool.js";
import { clamp, describe } from "./format.js";

/**
 * A hostname or IPv4 literal, and nothing else.
 *
 * The regex is the whole security argument for `ping`: it admits no leading
 * hyphen, no spaces and no slashes, so the argument cannot be read as a flag
 * or a second command however it reaches the process. Combined with a fixed
 * argv this leaves the model no way to shape the command line.
 */
const HOSTNAME = /^(?!-)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.(?!-)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export const currentTime = defineTool({
  name: "current_time",
  description:
    "Get the current date and time. Use this rather than guessing; you have no other " +
    "way to know what today is.",
  permission: "read",
  inputSchema: z.strictObject({
    timezone: z
      .string()
      .nullable()
      .describe('IANA timezone such as Asia/Kuala_Lumpur. Null uses UTC.'),
  }),
  async run(input): Promise<ToolResult> {
    const timeZone = input.timezone ?? "UTC";
    const now = new Date();

    // Deliberately not a subprocess. `date` would be one more thing that
    // behaves differently once tools move into a container, and this is
    // exactly what Intl is for.
    let formatted: string;
    try {
      formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(now);
    } catch (error) {
      return {
        content: `${timeZone} is not a recognised IANA timezone: ${describe(error)}`,
        isError: true,
      };
    }

    return { content: `${formatted}\nISO 8601 (UTC): ${now.toISOString()}` };
  },
});

export const ping = defineTool({
  name: "ping",
  description: "Check whether a host is reachable over the network, by ICMP echo.",
  permission: "exec",
  inputSchema: z.strictObject({
    host: z.string().describe("Hostname or IPv4 address, e.g. google.com"),
    count: z.number().int().min(1).max(5).nullable().describe("Echo requests to send. Null sends 3."),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const host = input.host.trim();
    if (host.length > 253 || !HOSTNAME.test(host)) {
      return { content: `${JSON.stringify(input.host)} is not a valid hostname.`, isError: true };
    }
    const count = input.count ?? 3;

    try {
      // Fixed argv, with the host last and every flag a literal. `-n` skips
      // reverse DNS, which is a second lookup nobody asked for.
      const result = await ctx.executor.exec(
        ["ping", "-n", "-c", String(count), "-W", "2", "--", host],
        { timeoutMs: (count + 3) * 2_000, signal: ctx.signal },
      );

      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (output === "") {
        return { content: `ping exited ${result.exitCode} with no output.`, isError: true };
      }
      // A non-zero exit means unreachable, which is an answer, not a failure
      // of the tool -- but the model should be told which it got.
      return { content: clamp(output), isError: result.exitCode !== 0 };
    } catch (error) {
      if (error instanceof ExecInterruptedError) {
        return { content: `ping ${host}: ${error.message}`, isError: true };
      }
      return { content: `Could not ping ${host}: ${describe(error)}`, isError: true };
    }
  },
});
