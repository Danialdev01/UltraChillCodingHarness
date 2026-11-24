import type { FileDiff } from "@ucch/protocol";
import { parsePatch, type DiffLine } from "./git-diff";
import { isShowWidgetTool } from "@ucch/protocol/plain";

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
  | { kind: "todo"; items: { text: string; status: "pending" | "active" | "done" }[] }
  | { kind: "widget" }
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

  if (isShowWidgetTool(call.name)) return { kind: "widget" };

  if (isShellCall(call.name)) {
    const command = shellCommand(input.command ?? input.cmd ?? call.input);
    if (command !== null) return { kind: "shell", command };
  }

  const todos = todoItems(input.todos ?? input.items ?? input.plan);
  if (todos && /^(todo_?write|plan_update|update_plan)$/i.test(call.name)) return { kind: "todo", items: todos };

  switch (call.name) {
    case "NotebookEdit":
      if (path && typeof input.new_source === "string") return { kind: "edit", path, edits: [{ old: "", new: input.new_source }] };
      break;
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

/** One shell word without its quotes, or null when `text` is more than one word. */
function shellWord(text: string): string | null {
  const pieces = /'([^']*)'|"((?:[^"\\]|\\[\s\S])*)"|\\([\s\S])|([^\s'"\\;&|<>()]+)/y;
  let out = "";
  while (pieces.lastIndex < text.length) {
    const match = pieces.exec(text);
    if (!match) return null;
    out += match[1] ?? match[2]?.replace(/\\([$`"\\])/g, "$1") ?? match[3] ?? match[4];
  }
  return out;
}

/** A command as one line: a string as is, Codex's argv joined, `bash -lc X` as X. */
function shellCommand(value: unknown): string | null {
  if (typeof value === "string") {
    const wrapped = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c ([\s\S]+)$/.exec(value);
    return (wrapped && shellWord(wrapped[1]!)) ?? value;
  }
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
  // Claude Code opens a failed command's result with its code.
  const claude = /^Exit code (\d+)(?:\n|$)/.exec(result);
  if (claude) return { output: result.slice(claude[0].length).replace(/\s+$/, ""), exitCode: Number(claude[1]) };
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

function todoItems(value: unknown): { text: string; status: "pending" | "active" | "done" }[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(record).flatMap((item) => {
    const text = str(item.content) ?? str(item.text) ?? str(item.step) ?? str(item.title);
    if (!text) return [];
    const done = item.completed === true || item.status === "completed" || item.status === "done";
    return [{ text, status: done ? ("done" as const) : item.status === "in_progress" ? ("active" as const) : ("pending" as const) }];
  });
  return items.length > 0 ? items : null;
}

/** One file's change as the view draws it, wherever it was read from. */
export interface FileView {
  path: string;
  oldPath?: string;
  change: FileDiff["change"];
  hunks: DiffLine[][];
  added: number;
  removed: number;
  /** The line numbers are the file's own, not the snippet's. */
  numbered: boolean;
  truncated: boolean;
}

export function fileViews(diffs: readonly FileDiff[]): FileView[] {
  return diffs.map((diff) => ({
    path: diff.path,
    ...(diff.oldPath ? { oldPath: diff.oldPath } : {}),
    change: diff.change,
    hunks: parsePatch(diff.patch).flatMap((file) => file.hunks.map((hunk) => hunk.lines)),
    added: diff.added,
    removed: diff.removed,
    numbered: true,
    truncated: diff.truncated,
  }));
}

/**
 * A call's change told from its input alone: while it runs, and for turns
 * from before diffs were stored. Null when the input has none to tell.
 */
export function inputViews(view: ToolView): FileView[] | null {
  if (view.kind === "write") return [viewOf(view.path, "added", [lineDiff("", view.content)], true)];
  if (view.kind === "edit") return [viewOf(view.path, "modified", view.edits.flatMap((e) => splitHunks(lineDiff(e.old, e.new))), false)];
  if (view.kind === "patch") return envelopeViews(view.patch);
  return null;
}

function viewOf(path: string, change: FileDiff["change"], hunks: DiffLine[][], numbered: boolean): FileView {
  const stats = diffStats(hunks.flat());
  return { path, change, hunks: hunks.filter((h) => h.length > 0), ...stats, numbered, truncated: false };
}

function splitHunks(lines: DiffLine[]): DiffLine[][] {
  const out: DiffLine[][] = [[]];
  for (const line of trimContext(lines)) {
    if (line.kind === "gap") out.push([]);
    else out.at(-1)!.push(line);
  }
  return out;
}

/** The `*** Begin Patch` format, which names files but not line numbers. */
function envelopeViews(patch: string): FileView[] | null {
  const files: { path: string; change: FileDiff["change"]; hunks: DiffLine[][] }[] = [];
  for (const line of patch.split("\n")) {
    const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (head) {
      files.push({ path: head[2]!.trim(), change: head[1] === "Add" ? "added" : head[1] === "Delete" ? "deleted" : "modified", hunks: [[]] });
      continue;
    }
    const file = files.at(-1);
    if (!file) continue;
    const moved = /^\*\*\* Move to: (.+)$/.exec(line);
    if (moved) file.path = moved[1]!.trim();
    else if (line.startsWith("***")) continue;
    else if (line.startsWith("@@")) file.hunks.push([]);
    else if (line !== "") {
      const kind = line[0] === "+" ? "add" : line[0] === "-" ? "del" : "context";
      file.hunks.at(-1)!.push({ kind, text: line.slice(1) });
    }
  }
  return files.length > 0 ? files.map((f) => viewOf(f.path, f.change, f.hunks, false)) : null;
}
