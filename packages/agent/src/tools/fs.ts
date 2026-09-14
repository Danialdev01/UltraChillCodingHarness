import { z } from "zod/v4";
import { defineTool, type ToolContext, type ToolResult } from "../tool.js";
import { clamp, describe, languageOf, numberLines } from "./format.js";

/** Lines returned when the model names no limit. */
const DEFAULT_LINE_LIMIT = 2_000;

/** A single line longer than this is truncated; minified bundles are one line. */
const MAX_LINE_LENGTH = 2_000;

/** Read from disk before line splitting, for both `read_file` and `edit_file`. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Entries in one `list_dir` answer. */
const MAX_ENTRIES = 200;

/**
 * The workspace root, spelled the two ways a model writes it.
 *
 * `normalizeWorkspacePath` returns null for both, so the executor refuses
 * them -- deliberately, because only the caller knows whether empty means
 * "the root" or "you forgot an argument". Here it means the root.
 */
function isRoot(path: string): boolean {
  return path === "" || path === "." || path === "./";
}

export const readFile = defineTool({
  name: "read_file",
  description:
    "Read a file from the project workspace. Returns the contents with line numbers. " +
    "Use offset and limit to page through a file that is too long to read at once.",
  permission: "read",
  inputSchema: z.strictObject({
    path: z.string().describe("Path relative to the workspace root, e.g. src/index.ts"),
    offset: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe("First line to return, 1-based. Null starts at the beginning."),
    limit: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe(`How many lines to return. Null returns up to ${DEFAULT_LINE_LIMIT}.`),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const content = await ctx.executor.readFile(input.path, { maxBytes: MAX_FILE_BYTES });
    if (content === "") {
      return { content: `${input.path} is empty.`, display: { path: input.path } };
    }

    // A trailing newline would otherwise show up as a final blank line that
    // is not in the file.
    const all = content.replace(/\n$/, "").split("\n");
    const offset = input.offset ?? 1;
    const limit = input.limit ?? DEFAULT_LINE_LIMIT;

    if (offset > all.length) {
      return {
        content: `${input.path} has ${all.length} lines; offset ${offset} is past the end.`,
        isError: true,
      };
    }

    const lines = all
      .slice(offset - 1, offset - 1 + limit)
      .map((line) =>
        line.length > MAX_LINE_LENGTH
          ? `${line.slice(0, MAX_LINE_LENGTH)}… (${line.length - MAX_LINE_LENGTH} more characters)`
          : line,
      );

    const shown = offset + lines.length - 1;
    const footer =
      shown < all.length
        ? `\n\n(showing lines ${offset}-${shown} of ${all.length}; read on from offset ${shown + 1})`
        : "";

    return {
      content: clamp(numberLines(lines, offset)) + footer,
      display: { path: input.path, language: languageOf(input.path) },
    };
  },
});

export const listDir = defineTool({
  name: "list_dir",
  description:
    "List the files and directories directly inside a workspace directory. " +
    "Respects .gitignore, so build output and dependencies are not listed.",
  permission: "read",
  inputSchema: z.strictObject({
    path: z
      .string()
      .describe('Directory relative to the workspace root. Use "" or "." for the root.'),
  }),
  async run(input, ctx): Promise<ToolResult> {
    const relative = isRoot(input.path) ? "" : input.path;
    // Validate before spawning, so a traversing path is refused by the same
    // rule whether or not ripgrep would have liked it.
    const target = relative === "" ? ctx.executor.root() : ctx.executor.resolve(relative);

    // `rg --files` is what gets .gitignore for free -- node_modules, .next
    // and build output would otherwise dominate every answer.
    const result = await ctx.executor.exec(["rg", "--no-config", "--files", "--", target], {
      timeoutMs: 20_000,
      signal: ctx.signal,
    });
    if (result.exitCode > 1) {
      return { content: `Could not list ${input.path || "."}: ${result.stderr.trim()}`, isError: true };
    }

    const prefix = relative === "" ? "" : `${relative.replace(/\/$/, "")}/`;
    const files = new Set<string>();
    const directories = new Set<string>();

    for (const line of result.stdout.split("\n")) {
      if (!line) continue;
      // rg prints paths as given; strip the workspace prefix back off.
      const workspacePath = line.startsWith(ctx.executor.root() + "/")
        ? line.slice(ctx.executor.root().length + 1)
        : line;
      if (prefix && !workspacePath.startsWith(prefix)) continue;

      const rest = workspacePath.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) files.add(rest);
      else directories.add(rest.slice(0, slash));
    }

    if (files.size === 0 && directories.size === 0) {
      return { content: `${input.path || "."} is empty or does not exist.` };
    }

    const entries = [
      ...[...directories].sort().map((d) => `${d}/`),
      ...[...files].sort(),
    ];
    const shown = entries.slice(0, MAX_ENTRIES);
    const footer =
      entries.length > shown.length ? `\n\n(${entries.length - shown.length} more entries)` : "";

    return {
      content: `${prefix || "."}\n${shown.join("\n")}${footer}`,
      display: { title: prefix || "." },
    };
  },
});

export const writeFile = defineTool({
  name: "write_file",
  description:
    "Write a file in the workspace, replacing it if it exists and creating parent " +
    "directories as needed. To change part of an existing file, prefer edit_file.",
  permission: "write",
  inputSchema: z.strictObject({
    path: z.string().describe("Path relative to the workspace root"),
    content: z.string().describe("The complete new contents of the file"),
  }),
  async run(input, ctx): Promise<ToolResult> {
    // Whether the file already existed decides the change kind, and it can
    // only be known before the write.
    const existed = await exists(ctx, input.path);
    await ctx.executor.writeFile(input.path, input.content);

    await ctx.emit({
      type: "file.changed",
      projectId: ctx.projectId,
      path: input.path,
      change: existed ? "modified" : "added",
    });

    const lines = input.content === "" ? 0 : input.content.split("\n").length;
    return {
      content: `${existed ? "Updated" : "Created"} ${input.path} (${lines} lines, ${Buffer.byteLength(input.content)} bytes).`,
      display: { path: input.path, language: languageOf(input.path) },
    };
  },
});

export const editFile = defineTool({
  name: "edit_file",
  description:
    "Replace an exact string in a file. The old_string must appear exactly once unless " +
    "replace_all is true, so include enough surrounding context to make it unique.",
  permission: "write",
  inputSchema: z.strictObject({
    path: z.string().describe("Path relative to the workspace root"),
    old_string: z.string().describe("The exact text to replace, including whitespace"),
    new_string: z.string().describe("What to put in its place"),
    replace_all: z
      .boolean()
      .nullable()
      .describe("Replace every occurrence instead of requiring exactly one"),
  }),
  async run(input, ctx): Promise<ToolResult> {
    if (input.old_string === input.new_string) {
      return { content: "old_string and new_string are identical; nothing to do.", isError: true };
    }
    if (input.old_string === "") {
      return {
        content: "old_string is empty. Use write_file to create or replace a whole file.",
        isError: true,
      };
    }

    let content: string;
    try {
      content = await ctx.executor.readFile(input.path, { maxBytes: MAX_FILE_BYTES });
    } catch (error) {
      return { content: `Could not read ${input.path}: ${describe(error)}`, isError: true };
    }

    // split/join rather than a regex: the model's string is literal text and
    // a stray `.` or `$` in it must not become a pattern.
    const parts = content.split(input.old_string);
    const occurrences = parts.length - 1;

    if (occurrences === 0) {
      return {
        content:
          `old_string was not found in ${input.path}. It must match exactly, ` +
          `including indentation and line endings.`,
        isError: true,
      };
    }
    if (occurrences > 1 && !input.replace_all) {
      return {
        content:
          `old_string appears ${occurrences} times in ${input.path}. Add surrounding ` +
          `context to make it unique, or set replace_all to true.`,
        isError: true,
      };
    }

    const updated = input.replace_all
      ? parts.join(input.new_string)
      : content.replace(input.old_string, input.new_string);

    await ctx.executor.writeFile(input.path, updated);
    await ctx.emit({
      type: "file.changed",
      projectId: ctx.projectId,
      path: input.path,
      change: "modified",
    });

    const replaced = input.replace_all ? occurrences : 1;
    return {
      content: `Replaced ${replaced} occurrence${replaced === 1 ? "" : "s"} in ${input.path}.`,
      display: { path: input.path, language: languageOf(input.path) },
    };
  },
});

export const deleteFile = defineTool({
  name: "delete_file",
  description:
    "Delete one file from the workspace. Only files, never directories, and one path per " +
    "call. To empty a file rather than remove it, use write_file with empty content.",
  permission: "write",
  inputSchema: z.strictObject({
    path: z.string().describe("Path relative to the workspace root, e.g. public/index.html"),
  }),
  async run(input, ctx): Promise<ToolResult> {
    if (isRoot(input.path)) {
      return { content: "Give the path of a file to delete.", isError: true };
    }

    let removed: boolean;
    try {
      removed = await ctx.executor.removeFile(input.path);
    } catch (error) {
      return { content: `Could not delete ${input.path}: ${describe(error)}`, isError: true };
    }

    // Not an error: the model asked for a state, and the state holds. Saying
    // so plainly stops it from retrying a delete that has nothing to do.
    if (!removed) {
      return { content: `${input.path} does not exist, so there was nothing to delete.` };
    }

    await ctx.emit({
      type: "file.changed",
      projectId: ctx.projectId,
      path: input.path,
      change: "deleted",
    });

    return { content: `Deleted ${input.path}.`, display: { path: input.path } };
  },
});

async function exists(ctx: ToolContext, path: string): Promise<boolean> {
  try {
    await ctx.executor.readFile(path, { maxBytes: 1 });
    return true;
  } catch {
    return false;
  }
}
