import { access, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * What a deleted session leaves behind in the CLIs' own folders under
 * `CREDS_ROOT`: Claude Code's transcript (`projects/<cwd>/<id>.jsonl`, and a
 * `<id>/` folder beside it for its subagents and tool output), Codex's
 * rollout (`sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`), and OMP's session
 * (`sessions/<project>/…<id>…`). Each is named by the session id the CLI
 * reported, so a deleted session's files are found by that id and removed.
 */

/** Below this an id could match a file it does not name. */
const MIN_ID_LENGTH = 16;
/** `sessions/YYYY/MM/DD/file` is the deepest any CLI nests one. */
const MAX_DEPTH = 4;

/** Removes every transcript named by one of `sessionIds`; returns how many entries went. */
export async function removeCliSessionFiles(credsRoot: string, sessionIds: Iterable<string>): Promise<number> {
  const ids = [...new Set(sessionIds)].filter((id) => id.length >= MIN_ID_LENGTH && !/[\\/]/.test(id));
  if (ids.length === 0) return 0;
  let removed = 0;
  for (const subject of await dirs(credsRoot)) {
    for (const cli of await dirs(join(credsRoot, subject))) {
      for (const top of ["projects", "sessions"]) {
        removed += await sweep(join(credsRoot, subject, cli, top), ids, 1);
      }
    }
  }
  return removed;
}

async function sweep(dir: string, ids: readonly string[], depth: number): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (ids.some((id) => entry.name.includes(id))) {
      await rm(path, { recursive: true, force: true });
      removed++;
    } else if (entry.isDirectory() && depth < MAX_DEPTH) {
      removed += await sweep(path, ids, depth + 1);
    }
  }
  return removed;
}

async function dirs(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
/** A rollout's first line names its `cwd`; this much of the file holds it. */
const ROLLOUT_HEAD_BYTES = 8 * 1024;

/**
 * Removes the CLIs' transcripts of projects that no longer exist: Claude
 * Code's `projects/<escaped cwd>/` folders, OMP's `sessions/<project>/`,
 * and Codex rollouts whose `cwd` was a project's checkout or worktree. Only
 * transcripts of trees under `workspaceRoot` are considered, so anything
 * else a CLI keeps there is left alone. Returns how many entries went.
 */
export async function removeOrphanCliFiles(
  credsRoot: string,
  workspaceRoot: string,
  isLive: (projectId: string) => boolean,
): Promise<number> {
  const root = workspaceRoot.replace(/\/+$/, "");
  // Claude Code names a project's folder by its cwd, every `/` and `.` a `-`.
  const escapedRoot = root.replace(/[^A-Za-z0-9]/g, "-");
  const projectOf = (cwd: string): string | null => {
    if (!cwd.startsWith(`${root}/`)) return null;
    return UUID.exec(cwd.slice(root.length))?.[0] ?? null;
  };
  let removed = 0;
  const drop = async (path: string) => {
    await rm(path, { recursive: true, force: true });
    removed++;
  };
  for (const subject of await dirs(credsRoot)) {
    for (const cli of await dirs(join(credsRoot, subject))) {
      const home = join(credsRoot, subject, cli);
      for (const name of await dirs(join(home, "projects"))) {
        if (!name.startsWith(escapedRoot)) continue;
        const rest = name.slice(escapedRoot.length);
        const id = UUID.exec(rest)?.[0];
        if (id && !isLive(id)) await drop(join(home, "projects", name));
        // A session's worktree that is gone: its session was deleted or settled.
        else if (id && rest.startsWith("--worktrees-")) {
          const tree = rest.slice(`--worktrees-${id}-`.length);
          if (/^[a-z0-9]+$/.test(tree) && !(await exists(join(root, ".worktrees", id, tree)))) await drop(join(home, "projects", name));
        }
      }
      for (const name of await dirs(join(home, "sessions"))) {
        if (UUID.test(name) && UUID.exec(name)![0] === name && !isLive(name)) await drop(join(home, "sessions", name));
      }
      for (const file of await rollouts(join(home, "sessions"))) {
        const cwd = await rolloutCwd(file);
        const id = cwd ? projectOf(cwd) : null;
        if (id && !isLive(id)) await drop(file);
      }
    }
  }
  return removed;
}

/** Codex's `sessions/YYYY/MM/DD/rollout-*.jsonl`. */
async function rollouts(sessions: string): Promise<string[]> {
  const found: string[] = [];
  for (const year of await dirs(sessions)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of await dirs(join(sessions, year))) {
      for (const day of await dirs(join(sessions, year, month))) {
        const entries = await readdir(join(sessions, year, month, day)).catch(() => []);
        for (const name of entries) if (name.startsWith("rollout-")) found.push(join(sessions, year, month, day, name));
      }
    }
  }
  return found;
}

async function rolloutCwd(file: string): Promise<string | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(ROLLOUT_HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, ROLLOUT_HEAD_BYTES, 0);
    // Matched rather than parsed: the line can run past the bytes read.
    const match = /"cwd":("(?:[^"\\]|\\.)*")/.exec(head.subarray(0, bytesRead).toString("utf8"));
    return match ? (JSON.parse(match[1]!) as string) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/**
 * The folder under `projects/` where Claude Code keeps a session started in
 * `cwd`: the path with every character but a letter or digit turned into
 * `-` (2.1.330: `/srv/http/app` is `-srv-http-app`). Null for a path so long
 * the CLI shortens it with a hash of its own, which this does not
 * reproduce.
 */
export function claudeProjectFolder(cwd: string): string | null {
  const folder = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return folder.length <= CLAUDE_PROJECT_FOLDER_MAX ? folder : null;
}

/** Longer than this, Claude Code cuts the folder name and adds a hash. */
const CLAUDE_PROJECT_FOLDER_MAX = 200;

/**
 * Whether a CLI can still resume `sessionId` from its folder `home`: Claude
 * Code's `projects/<cwd>/<id>.jsonl`, Codex's `sessions/…/rollout-…-<id>.jsonl`.
 * Each CLI deletes old transcripts itself (Claude Code after 30 days by
 * default), and `--resume` of one that is gone fails the turn outright.
 * True for any other CLI, or a folder with no transcripts at all, which this cannot judge.
 *
 * With `cwd`, Claude Code's is looked for only where `claude --resume` run
 * there looks (plan2 §3.6): a transcript under another project's folder is
 * one the CLI would not find, and resuming it fails the turn.
 */
export async function cliTranscriptExists(home: string, cli: string, sessionId: string, cwd?: string): Promise<boolean> {
  // No transcript folder at all is a CLI that keeps them elsewhere: nothing to judge by.
  if (cli === "claude") {
    if (!(await exists(join(home, "projects")))) return true;
    const folder = cwd ? claudeProjectFolder(cwd) : null;
    if (folder) return exists(join(home, "projects", folder, `${sessionId}.jsonl`));
    for (const project of await dirs(join(home, "projects"))) {
      if (await exists(join(home, "projects", project, `${sessionId}.jsonl`))) return true;
    }
    return false;
  }
  if (cli === "codex") {
    if (!(await exists(join(home, "sessions")))) return true;
    return (await rollouts(join(home, "sessions"))).some((file) => file.endsWith(`-${sessionId}.jsonl`));
  }
  return true;
}
