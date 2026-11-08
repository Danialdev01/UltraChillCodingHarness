import type { DiffLine } from "./git-diff";
import { isShellCall, type ToolPart } from "./chat-messages";

/**
 * What the transcript view needs to know about a tool call, read out of its
 * raw input.
 *
 * Each provider names and shapes its tools its own way. The native loop has
 * `edit_file {path, old_string, new_string}`, Claude Code has
 * `Edit {file_path, ...}` and `MultiEdit {file_path, edits[]}`, OMP has
 * `edit_file {input: <patch>}`, and Codex has `file_change {changes[]}`. They
 * are folded here into the handful of shapes the view draws. Anything not
 * recognised is `other`, and is drawn the way the default view draws it.
 */
export type ToolView =
  | { kind: "shell"; command: string }
  | { kind: "edit"; path: string; edits: { old: string; new: string }[] }
  | { kind: "write"; path: string; content: string }
  | { kind: "patch"; path: string | null; patch: string }
  | { kind: "files"; changes: { path: string; change: string }[] }
  | { kind: "delete"; path: string }
  | { kind: "read"; verb: string; label: string }
  | { kind: "other" };

const READ_TOOLS: Record<string, string> = {
  read_file: "Read",
  Read: "Read",
  list_dir: "List",
  LS: "List",
  glob: "Glob",
  Glob: "Glob",
  grep: "Grep",
  Grep: "Grep",
  web_search: "Search",
  WebSearch: "Search",
  web_fetch: "Fetch",
  WebFetch: "Fetch",
};

export function classifyTool(call: Pick<ToolPart, "name" | "input">): ToolView {
  const input = record(call.input);
  const path = str(input.path) ?? str(input.file_path) ?? str(input.notebook_path);

  if (isShellCall(call.name)) {
    const command = shellCommand(input.command ?? input.cmd ?? call.input);
    if (command !== null) return { kind: "shell", command };
  }

  switch (call.name) {
    case "edit_file":
    case "Edit":
    case "MultiEdit": {
      if (!path && typeof input.input === "string") return { kind: "patch", path: null, patch: input.input };
      if (!path) break;
      const edits = Array.isArray(input.edits)
        ? input.edits.map(record)
        : [input];
      const pairs = edits
        .map((e) => ({ old: str(e.old_string) ?? "", new: str(e.new_string) ?? "" }))
        .filter((e) => e.old || e.new);
      if (pairs.length > 0) return { kind: "edit", path, edits: pairs };
      if (typeof input.input === "string") return { kind: "patch", path, patch: input.input };
      break;
    }
    case "write_file":
    case "Write":
      if (path) return { kind: "write", path, content: str(input.content) ?? "" };
      break;
    case "delete_file":
      if (path) return { kind: "delete", path };
      break;
    case "apply_patch": {
      const patch = str(input.patch) ?? str(input.input) ?? (typeof call.input === "string" ? call.input : null);
      if (patch) return { kind: "patch", path: null, patch };
      break;
    }
    case "file_change":
      if (Array.isArray(input.changes)) {
        const changes = input.changes
          .map(record)
          .filter((c) => typeof c.path === "string")
          .map((c) => ({ path: c.path as string, change: str(c.kind) ?? "update" }));
        if (changes.length > 0) return { kind: "files", changes };
      }
      break;
  }

  const verb = READ_TOOLS[call.name];
  if (verb) {
    const label = path ?? str(input.pattern) ?? str(input.query) ?? str(input.url) ?? "";
    return { kind: "read", verb, label };
  }
  return { kind: "other" };
}

/** A command as one line: a string as is, Codex's argv joined, `bash -lc X` as X. */
function shellCommand(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    const argv = value as string[];
    if (argv.length === 3 && /(^|\/)(ba|z)?sh$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) return argv[2]!;
    return argv.join(" ");
  }
  return null;
}

/**
 * A shell call's result as its output and exit code. The native loop ends
 * every result with an `exit code: N` line (`packages/agent/src/tools/shell.ts`).
 * Other providers do not, and give null, which leaves the call's `isError`
 * to say how it went.
 */
export function parseShellResult(result: string): { output: string; exitCode: number | null } {
  const match = /(?:^|\n)exit code: (-?\d+)\s*$/.exec(result);
  if (!match) return { output: result.replace(/\s+$/, ""), exitCode: null };
  const output = result.slice(0, match.index).replace(/\s+$/, "");
  return { output: output === "(no output)" ? "" : output, exitCode: Number(match[1]) };
}

/** Above this many lines on either side, a diff is drawn as all removed then all added. */
export const LINE_DIFF_CAP = 400;

/**
 * Lines removed and added between two snippets, by longest common
 * subsequence. Line numbers count from 1 within each snippet: an edit's
 * strings carry no position in the file.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: DiffLine[] = [];

  if (a.length > LINE_DIFF_CAP || b.length > LINE_DIFF_CAP) {
    a.forEach((text, i) => out.push({ kind: "del", text, oldNo: i + 1 }));
    b.forEach((text, j) => out.push({ kind: "add", text, newNo: j + 1 }));
    return out;
  }

  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: "context", text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push({ kind: "add", text: b[j]!, newNo: j + 1 });
      j++;
    } else {
      out.push({ kind: "del", text: a[i]!, oldNo: i + 1 });
      i++;
    }
  }
  // Deletions before additions within each changed run, the way diffs read.
  return reorderRuns(out);
}

function reorderRuns(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    out.push(...run.filter((l) => l.kind === "del"), ...run.filter((l) => l.kind === "add"));
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "context") {
      flush();
      out.push(line);
    } else run.push(line);
  }
  flush();
  return out;
}

export type TrimmedLine = DiffLine | { kind: "gap"; count: number };

/** Unchanged runs cut to `context` lines either side of a change, the rest a gap. */
export function trimContext(lines: DiffLine[], context = 3): TrimmedLine[] {
  const keep = lines.map(() => false);
  lines.forEach((line, i) => {
    if (line.kind === "context") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: TrimmedLine[] = [];
  let gap = 0;
  lines.forEach((line, i) => {
    if (keep[i]) {
      if (gap) out.push({ kind: "gap", count: gap });
      gap = 0;
      out.push(line);
    } else gap++;
  });
  if (gap && out.length > 0) out.push({ kind: "gap", count: gap });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
