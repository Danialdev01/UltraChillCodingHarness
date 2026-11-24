import { z } from "zod";

/** What a step did to one file, as a diff the chat can draw. */
export const FileDiff = z.object({
  path: z.string().max(4096),
  /** Where it was, for a rename. */
  oldPath: z.string().max(4096).optional(),
  change: z.enum(["added", "modified", "deleted"]),
  /** Unified hunks only, from the first `@@`. Empty for a binary file or an empty one. */
  patch: z.string(),
  /** Of the whole change, not of what `patch` was cut to. */
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type FileDiff = z.infer<typeof FileDiff>;

/** Characters of `patch` kept for one file, and for all of an event's files. */
export const FILE_PATCH_CAP = 64 * 1024;
export const EVENT_PATCH_CAP = 256 * 1024;
/** Files one event names. */
export const EVENT_FILE_CAP = 200;

interface Naming {
  path: string;
  oldPath?: string | undefined;
  change: FileDiff["change"];
}

/** A `FileDiff` from a unified diff's text; anything before its first hunk is dropped. */
export function diffFromPatch(naming: Naming, text: string): FileDiff {
  const start = text.startsWith("@@") ? 0 : text.indexOf("\n@@") + 1;
  const patch = start === 0 && !text.startsWith("@@") ? "" : text.slice(start).replace(/\n$/, "");
  const { added, removed } = countLines(patch);
  const cut = cutAtLine(patch, FILE_PATCH_CAP);
  return {
    path: naming.path,
    ...(naming.oldPath ? { oldPath: naming.oldPath } : {}),
    change: naming.change,
    patch: cut,
    added,
    removed,
    truncated: cut.length < patch.length,
  };
}

/** A file's lines, all added or all removed. */
export function diffFromContent(path: string, change: "added" | "deleted", content: string): FileDiff {
  return change === "added" ? diffFromTexts({ path, change }, "", content) : diffFromTexts({ path, change }, content, "");
}

/** The middle of a change is matched line by line up to this many lines a side. */
const MATCH_CAP = 600;
const CONTEXT = 3;

/**
 * The hunks between two whole texts. The common head and tail are set
 * aside first, so a small edit to a large file costs little; a very large
 * change is told as everything removed, then everything added.
 */
export function diffFromTexts(naming: Naming, before: string, after: string): FileDiff {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ops: { sign: " " | "-" | "+"; text: string }[] = [];
  const from = Math.max(0, head - CONTEXT);
  for (let i = from; i < head; i++) ops.push({ sign: " ", text: a[i]! });
  ops.push(...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)));
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + CONTEXT); i++) ops.push({ sign: " ", text: a[i]! });
  return diffFromPatch(naming, hunks(ops, from));
}

function middle(a: string[], b: string[]): { sign: " " | "-" | "+"; text: string }[] {
  const del = (text: string) => ({ sign: "-" as const, text });
  const add = (text: string) => ({ sign: "+" as const, text });
  if (a.length > MATCH_CAP || b.length > MATCH_CAP) return [...a.map(del), ...b.map(add)];
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: { sign: " " | "-" | "+"; text: string }[] = [];
  let adds: typeof out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(...adds, { sign: " ", text: a[i]! });
      adds = [];
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) out.push(del(a[i++]!));
    else adds.push(add(b[j++]!));
  }
  return [...out, ...adds];
}

/** Unified hunks of `ops`, which start at line `offset` (from 0) on both sides. */
function hunks(ops: { sign: " " | "-" | "+"; text: string }[], offset: number): string {
  const keep = ops.map(() => false);
  ops.forEach((op, i) => {
    if (op.sign === " ") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const out: string[] = [];
  let oldNo = offset + 1;
  let newNo = offset + 1;
  for (let i = 0; i < ops.length; ) {
    if (!keep[i]) {
      oldNo++;
      newNo++;
      i++;
      continue;
    }
    const body: string[] = [];
    let oldLines = 0;
    let newLines = 0;
    for (; i < ops.length && keep[i]; i++) {
      const op = ops[i]!;
      body.push(op.sign + op.text);
      if (op.sign !== "+") oldLines++;
      if (op.sign !== "-") newLines++;
    }
    out.push(`@@ -${oldLines ? oldNo : oldNo - 1},${oldLines} +${newLines ? newNo : newNo - 1},${newLines} @@`, ...body);
    oldNo += oldLines;
    newNo += newLines;
  }
  return out.join("\n");
}

/** Holds an event's files to its caps: past them a file keeps its name and counts, not its patch. */
export function capFileDiffs(files: readonly FileDiff[]): { files: FileDiff[]; omitted: number } {
  let left = EVENT_PATCH_CAP;
  const kept = files.slice(0, EVENT_FILE_CAP).map((file) => {
    const patch = cutAtLine(file.patch, left);
    left -= patch.length;
    return patch.length < file.patch.length ? { ...file, patch, truncated: true } : file;
  });
  return { files: kept, omitted: files.length - kept.length };
}

function cutAtLine(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return text.slice(0, Math.max(0, text.lastIndexOf("\n", cap)));
}

function countLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
