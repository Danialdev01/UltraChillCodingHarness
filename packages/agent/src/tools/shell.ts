import { z } from "zod/v4";
import { ExecInterruptedError } from "../executor.js";
import { defineTool, type ToolResult } from "../tool.js";
import { clamp, describe } from "./format.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * A shell, on the host, as the server user.
 *
 * Until the container runtime lands this is remote code execution by
 * whichever model the composer selected, and it was chosen knowingly rather
 * than arrived at -- see `idea.md` §2.1. Three things hold it in: the
 * registry refuses to offer this tool in production unless
 * `AGENT_ALLOW_HOST_SHELL` is set, the working directory is the project's
 * workspace, and the environment the child gets is rebuilt rather than
 * inherited. None of them makes it safe; the container executor is what does.
 */
export const bash = defineTool({
  name: "bash",
  description:
    "Run a shell command in the project workspace. Use this for builds, tests, package " +
    "managers and git. Prefer read_file, glob and grep for reading and searching files.",
  permission: "exec",
  // Above the tool's own maximum, so the loop's backstop never fires first
  // and turns a long build into a mystery.
  timeoutMs: MAX_TIMEOUT_MS + 30_000,
  inputSchema: z.strictObject({
    command: z.string().describe("The shell command to run"),
    timeout_ms: z
      .number()
      .int()
      .min(1_000)
      .max(MAX_TIMEOUT_MS)
      .nullable()
      .describe(`How long to allow. Null means ${DEFAULT_TIMEOUT_MS / 1000} seconds.`),
  }),
  async run(input, ctx): Promise<ToolResult> {
    if (input.command.trim() === "") {
      return { content: "No command given.", isError: true };
    }
    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    try {
      // The one place a shell string is legitimate, and it is explicit: every
      // other tool passes argv arrays precisely so nothing is word-split.
      const result = await ctx.executor.exec(["bash", "-lc", input.command], {
        timeoutMs,
        signal: ctx.signal,
      });

      return {
        content: report(result.stdout, result.stderr, result.exitCode, result.truncated),
        isError: result.exitCode !== 0,
        display: { title: input.command },
      };
    } catch (error) {
      if (error instanceof ExecInterruptedError) {
        // The output up to the interruption is the useful part: a test run
        // that hangs at 119 seconds has usually already said why.
        const partial = report(
          error.result.stdout,
          error.result.stderr,
          error.result.exitCode,
          error.result.truncated,
        );
        return { content: `${error.message}\n\n${partial}`, isError: true };
      }
      return { content: `Could not run the command: ${describe(error)}`, isError: true };
    }
  },
});

/** Both streams, labelled, with the exit code -- never an empty string. */
function report(stdout: string, stderr: string, exitCode: number, truncated: boolean): string {
  const sections: string[] = [];
  if (stdout.trim()) sections.push(stdout.trimEnd());
  if (stderr.trim()) sections.push(`stderr:\n${stderr.trimEnd()}`);
  if (sections.length === 0) sections.push("(no output)");
  if (truncated) sections.push("(output was truncated by the executor)");
  sections.push(`exit code: ${exitCode}`);
  return clamp(sections.join("\n\n"));
}
