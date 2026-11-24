import { capFileDiffs, diffFromContent, diffFromPatch, type DomainEvent, type FileDiff } from "@ucch/protocol";

/** One `agent.file_diff` for a call, or none when there is nothing to show. */
export function fileDiffEvent(
  ids: { threadId: string; turnId: string },
  toolUseId: string,
  files: readonly FileDiff[],
): DomainEvent[] {
  return files.length ? [{ type: "agent.file_diff", ...ids, toolUseId, files: capFileDiffs(files).files }] : [];
}

/**
 * What Claude Code says an edit did (`tool_use_result`): the hunks it
 * computed against the file, or a new file's content with no hunks.
 */
export function claudeFileDiff(name: (path: string) => string, raw: unknown): FileDiff | null {
  if (typeof raw !== "object" || raw === null) return null;
  const result = raw as { type?: unknown; filePath?: unknown; content?: unknown; structuredPatch?: unknown };
  if (typeof result.filePath !== "string" || !Array.isArray(result.structuredPatch)) return null;
  const path = name(result.filePath);
  if (result.type === "create" && result.structuredPatch.length === 0) {
    return diffFromContent(path, "added", typeof result.content === "string" ? result.content : "");
  }
  const hunks: string[] = [];
  for (const entry of result.structuredPatch) {
    const hunk = (entry ?? {}) as { oldStart?: unknown; oldLines?: unknown; newStart?: unknown; newLines?: unknown; lines?: unknown };
    if (!Array.isArray(hunk.lines)) continue;
    hunks.push(`@@ -${Number(hunk.oldStart) || 0},${Number(hunk.oldLines) || 0} +${Number(hunk.newStart) || 0},${Number(hunk.newLines) || 0} @@`);
    hunks.push(...hunk.lines.map(String));
  }
  return hunks.length ? diffFromPatch({ path, change: result.type === "create" ? "added" : "modified" }, hunks.join("\n")) : null;
}

/**
 * A Codex rollout's `FileChange` item: each path with a unified diff for an
 * update, or the file's content for an add or a delete.
 */
export function codexFileDiffs(name: (path: string) => string, raw: unknown): FileDiff[] {
  const changes = (raw as { changes?: unknown } | null)?.changes;
  if (typeof changes !== "object" || changes === null) return [];
  return Object.entries(changes as Record<string, unknown>).flatMap(([path, value]) => {
    const change = (value ?? {}) as { type?: unknown; unified_diff?: unknown; content?: unknown; move_path?: unknown };
    const content = typeof change.content === "string" ? change.content : "";
    if (change.type === "add") return [diffFromContent(name(path), "added", content)];
    if (change.type === "delete") return [diffFromContent(name(path), "deleted", content)];
    if (typeof change.unified_diff !== "string") return [];
    return [
      typeof change.move_path === "string"
        ? diffFromPatch({ path: name(change.move_path), oldPath: name(path), change: "modified" }, change.unified_diff)
        : diffFromPatch({ path: name(path), change: "modified" }, change.unified_diff),
    ];
  });
}
