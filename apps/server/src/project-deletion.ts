import { readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import type { GitService } from "./git.js";
import { projectRoot, sessionTreesOf } from "./trees.js";

export interface DeletionTree {
  session: string | null;
  changes: number;
  canCommit: boolean;
}

/** Include orphaned worktrees too: deleting a thread must not hide its files. */
export async function projectDeletionCheck(root: string, projectId: string, git: GitService): Promise<{ trees: DeletionTree[] }> {
  const dirs: { session: string | null; tree: string }[] = [{ session: null, tree: projectRoot(root, projectId) }];
  const entries = await readdir(sessionTreesOf(root, projectId), { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (entry.isDirectory()) dirs.push({ session: entry.name, tree: join(sessionTreesOf(root, projectId), entry.name) });
  }
  const trees: DeletionTree[] = [];
  for (const dir of dirs) {
    const info = await lstat(dir.tree).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error("Cannot inspect a linked project directory");
    const target = { projectId, tree: dir.tree };
    const canCommit = await git.isRepo(target);
    const changes = canCommit
      ? (await git.status(target)).files.length
      : (await readdir(dir.tree)).length;
    if (changes) trees.push({ session: dir.session, changes, canCommit });
  }
  return { trees };
}
