/**
 * Workspace path normalisation.
 *
 * This lives in the protocol package rather than in the server because two
 * callers need exactly the same answer: `decide()` validating a `file.write`
 * command, and the agent's `Executor.resolve()` turning a model-supplied path
 * into a real one. Two copies would drift, and the one that drifted would be
 * the one that let a path out of the workspace.
 */

/**
 * Rejects any path that escapes `/workspace`.
 *
 * Purely lexical: it resolves `.`, `..`, empty segments and a leading `/`,
 * and returns `null` for anything that would climb above the root, for a null
 * byte, and for input that normalises to nothing. Callers must treat `null`
 * as a refusal, never as "use the root" -- `list_dir("")` wants the root, and
 * that decision belongs to the caller rather than here.
 *
 * It says nothing about symlinks: a path that normalises cleanly can still
 * point outside the tree once the filesystem resolves it. That check belongs
 * to the executor, which has a real root to compare against.
 */
export function normalizeWorkspacePath(input: string): string | null {
  if (input.includes("\0")) return null;
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}
