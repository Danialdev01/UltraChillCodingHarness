import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { projectRoot, sessionTreesOf } from "./trees.js";
import { TurnSnapshots } from "./turn-snapshot.js";

/**
 * Removing everything a deleted project has on disk.
 *
 * A plain recursive `rm` fails on two ordinary things: a folder without write
 * permission (Go's module cache is full of them), and a dev server that is
 * still writing. So the project's processes are stopped first, its folders
 * are moved to `WORKSPACE_ROOT/.trash` -- out of the way of anything that
 * names them by path -- and deleted from there, permissions fixed as needed.
 *
 * What still cannot be removed (another user's files) stays in the trash,
 * which is emptied again at boot and every hour.
 */

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error) => codeOf(error) !== "ENOENT",
  );

/** Gives every folder under `path` back its owner's rights. Never through a link. */
async function unlock(path: string): Promise<void> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory()) return;
  if ((info.mode & 0o700) !== 0o700) await chmod(path, (info.mode & 0o7777) | 0o700).catch(() => {});
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) if (entry.isDirectory()) await unlock(join(path, entry.name));
}

/** `rm -rf` that also gets through read-only folders and late writers. Throws what it could not get past. */
export async function forceRemove(path: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rm(path, { recursive: true, force: true });
    } catch (error) {
      if (attempt >= attempts) throw error;
      const code = codeOf(error);
      if (code === "EACCES" || code === "EPERM") await unlock(path);
      else await sleep(100 * attempt);
    }
  }
}

const trashOf = (workspaceRoot: string) => join(workspaceRoot, ".trash");

/** Moves a folder to the trash and deletes it there. */
async function discard(workspaceRoot: string, path: string): Promise<void> {
  if (!(await exists(path))) return;
  const trashed = join(trashOf(workspaceRoot), randomUUID());
  await mkdir(trashOf(workspaceRoot), { recursive: true, mode: 0o700 });
  try {
    await rename(path, trashed);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    // Not movable (a mount, a folder of another user's): deleted where it is.
    return forceRemove(path);
  }
  await forceRemove(trashed);
}

/** Tries again at what earlier deletions could not remove. Returns what is still there. */
export async function emptyTrash(workspaceRoot: string): Promise<string[]> {
  const left: string[] = [];
  for (const name of await readdir(trashOf(workspaceRoot)).catch(() => [])) {
    const path = join(trashOf(workspaceRoot), name);
    await forceRemove(path).catch(() => left.push(path));
  }
  return left;
}

/** The server and what it runs under: never stopped, even started from a project's own terminal. */
async function ownPids(): Promise<Set<number>> {
  const pids = new Set<number>();
  for (let pid = process.pid; pid > 1 && !pids.has(pid); ) {
    pids.add(pid);
    const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
    pid = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? 0);
  }
  return pids;
}

/**
 * The harness's own processes for a project, by what it started them with:
 * a terminal's `UCCH_ROOT`, or the project's runtimes folder on `PATH`.
 * Someone's editor or shell that merely has the folder open has neither.
 * Empty where there is no `/proc`.
 */
async function projectPids(workspaceRoot: string, projectId: string, binDir: string): Promise<number[]> {
  const root = projectRoot(workspaceRoot, projectId);
  const worktrees = `${sessionTreesOf(workspaceRoot, projectId)}/`;
  const own = await ownPids();
  const pids: number[] = [];
  for (const name of await readdir("/proc").catch(() => [])) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1 || own.has(pid)) continue;
    const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
    const mine = environ.split("\0").some((entry) => {
      if (entry.startsWith("UCCH_ROOT=")) {
        const dir = entry.slice("UCCH_ROOT=".length);
        return dir === root || dir.startsWith(worktrees);
      }
      return entry.startsWith("PATH=") && entry.slice("PATH=".length).split(delimiter).includes(binDir);
    });
    if (mine) pids.push(pid);
  }
  return pids;
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Stops what the harness started in a project: SIGTERM, and SIGKILL for what is left after `graceMs`. */
export async function stopProjectProcesses(
  workspaceRoot: string,
  projectId: string,
  binDir: string,
  graceMs = 2_000,
): Promise<void> {
  const until = Date.now() + graceMs;
  let pids = await projectPids(workspaceRoot, projectId, binDir);
  signalAll(pids, "SIGTERM");
  while (pids.length && Date.now() < until) {
    await sleep(100);
    pids = await projectPids(workspaceRoot, projectId, binDir);
  }
  signalAll(pids, "SIGKILL");
}

/**
 * A deleted project's checkout, worktrees, snapshots and attachments. Every
 * folder is tried whatever becomes of the others; returns what went wrong.
 */
export async function removeProjectFolders(workspaceRoot: string, projectId: string): Promise<unknown[]> {
  const folders = [
    projectRoot(workspaceRoot, projectId),
    sessionTreesOf(workspaceRoot, projectId),
    TurnSnapshots.dirOf(workspaceRoot, projectId),
    join(workspaceRoot, ".uploads", projectId),
  ];
  const results = await Promise.allSettled(folders.map((path) => discard(workspaceRoot, path)));
  return results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
}
