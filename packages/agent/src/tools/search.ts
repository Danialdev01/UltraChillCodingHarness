import { z } from "zod/v4";
import { defineTool, type ToolContext, type ToolResult } from "../tool.js";
import { clamp } from "./format.js";

/** Paths in one `glob` answer. */
const MAX_PATHS = 200;

/** Matching lines in one `grep` answer, before the byte clamp also applies. */
const MAX_MATCHES = 100;

const SEARCH_TIMEOUT_MS = 30_000;

/**
 * Search is ripgrep, with no index and no embeddings.
 *
 * There is nothing to build or invalidate, so a repository cloned thirty
 * seconds ago is searchable immediately -- and an index would need
 * re-embedding after every edit the agent itself makes, going stale at
 * exactly the moment it matters most. "Where is this called?" wants every
 * call site, not the five most semantically similar chunks.
 */

export const glob = defineTool({
  name: "glob",
  description:
    "Find files whose path matches a glob pattern, such as **/*.ts or src/**/*.test.*. " +
    "Respects .gitignore.",
  permission: "read",
  inputSchema: z.strictObject({
    pattern: z.string().describe("Glob pattern, e.g. **/*.php"),
    path: z
      .string()
      .nullable()
      .describe("Directory to search under, relative to the workspace root. Null searches all."),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const target = resolveTarget(ctx, input.path);
    const result = await ctx.executor.exec(
      // The pattern is the value of -g, a separate argv element, so it can
      // never be read as a flag however it starts.
      ["rg", "--no-config", "--files", "-g", input.pattern, "--", target],
      { timeoutMs: SEARCH_TIMEOUT_MS, signal: ctx.signal },
    );

    // 1 means "nothing matched", which is an answer rather than a failure.
    if (result.exitCode > 1) {
      return { content: `glob failed: ${result.stderr.trim() || "ripgrep error"}`, isError: true };
    }

    const paths = relativise(ctx, result.stdout).sort();
    if (paths.length === 0) {
      return { content: `No files match ${input.pattern}.` };
    }

    const shown = paths.slice(0, MAX_PATHS);
    const footer = paths.length > shown.length ? `\n\n(${paths.length - shown.length} more)` : "";
    return { content: clamp(shown.join("\n")) + footer, display: { title: input.pattern } };
  },
});

export const grep = defineTool({
  name: "grep",
  description:
    "Search file contents for a regular expression. Returns matching lines as " +
    "path:line: text. Respects .gitignore.",
  permission: "read",
  inputSchema: z.strictObject({
    pattern: z.string().describe("Regular expression, in ripgrep syntax"),
    path: z
      .string()
      .nullable()
      .describe("Directory or file to search, relative to the workspace root"),
    glob: z
      .string()
      .nullable()
      .describe("Only search files matching this glob, e.g. *.ts"),
    context: z
      .number()
      .int()
      .min(0)
      .max(10)
      .nullable()
      .describe("Lines of context around each match. Null means none."),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const target = resolveTarget(ctx, input.path);
    const context = input.context ?? 0;

    // `--no-config` first: a hostile `RIPGREP_CONFIG_PATH` would otherwise
    // rewrite the flags this builds up below.
    const argv = ["rg", "--no-config", "--json", "--line-number"];
    if (context > 0) argv.push("-C", String(context));
    if (input.glob) argv.push("-g", input.glob);
    // Everything after `--` is data: a pattern of "--files" searches for that
    // text rather than switching ripgrep into another mode.
    argv.push("--", input.pattern, target);

    const result = await ctx.executor.exec(argv, {
      timeoutMs: SEARCH_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (result.exitCode > 1) {
      return {
        content: `grep failed: ${result.stderr.trim() || "invalid pattern"}`,
        isError: true,
      };
    }

    const lines: string[] = [];
    let matches = 0;
    let capped = false;

    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      let event: RgEvent;
      try {
        event = JSON.parse(line) as RgEvent;
      } catch {
        continue;
      }
      if (event.type !== "match" && event.type !== "context") continue;

      if (event.type === "match") {
        if (matches >= MAX_MATCHES) {
          capped = true;
          continue;
        }
        matches++;
      } else if (capped) {
        // Context belonging to matches past the cap would be adrift.
        continue;
      }

      const path = relativisePath(ctx, event.data.path?.text ?? "");
      const text = (event.data.lines?.text ?? "").replace(/\n$/, "");
      // `:` for a match and `-` for context is the convention grep itself
      // uses, and it is what lets the model tell them apart at a glance.
      const separator = event.type === "match" ? ":" : "-";
      lines.push(`${path}${separator}${event.data.line_number ?? 0}${separator} ${text}`);
    }

    if (lines.length === 0) {
      return { content: `No matches for ${input.pattern}.` };
    }

    const footer = capped ? `\n\n(stopped after ${MAX_MATCHES} matches; narrow the search)` : "";
    return { content: clamp(lines.join("\n")) + footer, display: { title: input.pattern } };
  },
});

/** A directory argument, defaulting to the whole workspace. */
function resolveTarget(ctx: ToolContext, path: string | null): string {
  if (path === null || path === "" || path === "." || path === "./") return ctx.executor.root();
  return ctx.executor.resolve(path);
}

function relativise(ctx: ToolContext, stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => relativisePath(ctx, line));
}

/** Absolute paths are an artefact of how ripgrep was invoked, not information. */
function relativisePath(ctx: ToolContext, path: string): string {
  const prefix = ctx.executor.root() + "/";
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

interface RgEvent {
  type: string;
  data: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}
