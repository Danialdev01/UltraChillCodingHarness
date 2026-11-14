import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot } from "./trees.js";

/**
 * What a session workspace's session folder holds besides the harness's own
 * bookkeeping: `.agent/` (diagrams, env vault, notes) and `.git/`, which
 * every session starts with, and the `README.md` it was initialised with
 * (`# {name}` and nothing else; see `clone.ts`). Anything else is something
 * the person or the agent made, and settling asks before it goes.
 *
 * Top-level names only, at most `limit` of them; `count` is the full number.
 */
const HARNESS_ENTRIES = new Set([".agent", ".git"]);

export async function sessionFilesBeyondAgent(
  workspaceRoot: string,
  projectId: string,
  limit = 20,
): Promise<{ count: number; names: string[] }> {
  const root = projectRoot(workspaceRoot, projectId);
  const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return { count: 0, names: [] };
  if (info.isSymbolicLink()) throw new Error("Cannot inspect a linked session directory");
  const names: string[] = [];
  for (const name of (await readdir(root)).sort()) {
    if (HARNESS_ENTRIES.has(name)) continue;
    if (name === "README.md" && (await isSeedReadme(join(root, name)))) continue;
    names.push(name);
  }
  return { count: names.length, names: names.slice(0, limit) };
}

/** The README a new session is initialised with: one `# title` line, untouched since. */
async function isSeedReadme(path: string): Promise<boolean> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size > 300) return false;
  const text = await readFile(path, "utf8").catch(() => null);
  return text !== null && /^# [^\n]*\n?$/.test(text);
}
