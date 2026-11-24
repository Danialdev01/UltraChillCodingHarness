import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { capFileDiffs, diffFromPatch, type FileDiff } from "@ucch/protocol";
import { runGit } from "./git-exec.js";

/**
 * What a turn changed in its tree, whoever wrote it: `sed`, a formatter and
 * a code generator leave no diff of their own.
 *
 * The tree is written into a git directory of its own before the turn and
 * after it, and the two compared. Never the project's `.git`: its index,
 * refs and objects stay as they are, and since none of the repository's
 * config is read, neither is any filter or hook an agent could have written
 * there. The index is kept between turns, so only changed files are read.
 */
export class TurnSnapshots {
  /** One git at a time per shadow: they share an index. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly timeouts = { before: 5_000, after: 10_000 },
  ) {}

  /** Where a project's shadows are, removed with the project. */
  static dirOf(workspaceRoot: string, projectId: string): string {
    return join(workspaceRoot, ".snapshots", projectId);
  }

  /** The tree as it stands, or null when it is not a git checkout. */
  async capture(projectId: string, tree: string): Promise<string | null> {
    if (!existsSync(join(tree, ".git"))) return null;
    const dir = this.#shadow(projectId, tree);
    return this.#queued(dir, async () => {
      await this.#prepare(projectId, dir, tree);
      return this.#write(dir, tree, this.timeouts.before);
    });
  }

  /** What changed since `before`. */
  async changes(projectId: string, tree: string, before: string): Promise<{ files: FileDiff[]; omitted: number }> {
    const dir = this.#shadow(projectId, tree);
    return this.#queued(dir, async () => {
      const after = await this.#write(dir, tree, this.timeouts.after);
      if (after === before) return { files: [], omitted: 0 };
      const git = (argv: string[]) => runGit(argv, tree, this.timeouts.after, { env: shadowEnv(dir, tree) });
      const names = parseNames(await git(["diff", "-M", "--name-status", "-z", before, after]));
      // Too much to hold: the files are still named.
      const patches = await git(["diff", "-M", "-U3", "--no-color", "--no-ext-diff", "--no-textconv", before, after])
        .then((out) => out.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git ")))
        .catch(() => null);
      const whole = patches?.length === names.length ? patches : null;
      return capFileDiffs(
        names.map((name, i) => (whole ? diffFromPatch(name, whole[i]!) : { ...diffFromPatch(name, ""), truncated: true })),
      );
    });
  }

  #shadow(projectId: string, tree: string): string {
    return join(TurnSnapshots.dirOf(this.workspaceRoot, projectId), createHash("sha256").update(tree).digest("hex").slice(0, 16));
  }

  async #queued<T>(dir: string, run: () => Promise<T>): Promise<T> {
    const turn = (this.#queues.get(dir) ?? Promise.resolve()).then(run, run);
    const settled = turn.catch(() => {});
    this.#queues.set(dir, settled);
    try {
      return await turn;
    } finally {
      if (this.#queues.get(dir) === settled) this.#queues.delete(dir);
    }
  }

  async #prepare(projectId: string, dir: string, tree: string): Promise<void> {
    const root = TurnSnapshots.dirOf(this.workspaceRoot, projectId);
    // A session's shadow goes once its worktree has.
    for (const name of await readdir(root).catch(() => [] as string[])) {
      const other = join(root, name);
      const of = await readFile(join(other, "ucch-tree"), "utf8").catch(() => null);
      if (of !== null && !existsSync(of)) await rm(other, { recursive: true, force: true });
    }
    if (await this.#oversized(dir)) await rm(dir, { recursive: true, force: true });
    if (!existsSync(join(dir, "HEAD"))) {
      await mkdir(dir, { recursive: true });
      await runGit(["init", "--bare", "--quiet", dir], root, this.timeouts.before);
      await writeFile(join(dir, "ucch-tree"), tree);
    }
    const own = await runGit(["rev-parse", "--git-path", "info/exclude"], tree, this.timeouts.before, { read: true })
      .then((path) => readFile(resolve(tree, path.trim()), "utf8"))
      .catch(() => "");
    await mkdir(join(dir, "info"), { recursive: true });
    await writeFile(join(dir, "info", "exclude"), `${own}\n${ALWAYS_EXCLUDED.join("\n")}\n`);
  }

  async #oversized(dir: string): Promise<boolean> {
    const loose = await readdir(join(dir, "objects")).catch(() => [] as string[]);
    // Loose objects spread evenly over 256 folders: one tells of the rest.
    const sample = loose.find((name) => /^[0-9a-f]{2}$/.test(name));
    if (!sample) return false;
    const count = (await readdir(join(dir, "objects", sample))).length;
    const index = await stat(join(dir, "index")).catch(() => null);
    const tracked = index ? index.size / 100 : 0;
    return count * 256 > 50_000 + tracked * 4;
  }

  async #write(dir: string, tree: string, timeoutMs: number): Promise<string> {
    const env = shadowEnv(dir, tree);
    // Left by a git that ran out of time; nothing else writes here.
    await rm(join(dir, "index.lock"), { force: true });
    await runGit(["add", "-A", "--ignore-errors", "--", "."], tree, timeoutMs, { env, okExitCodes: [0, 1] });
    return (await runGit(["write-tree"], tree, timeoutMs, { env })).trim();
  }
}

/** Not worth comparing where a project forgot to ignore them, or not the log's to keep. */
const ALWAYS_EXCLUDED = ["node_modules/", ".venv/", "__pycache__/", ".next/", ".env", ".env.*", "!.env.example"];

function shadowEnv(dir: string, tree: string): Record<string, string> {
  return { GIT_DIR: dir, GIT_WORK_TREE: tree };
}

/** `--name-status -z`: a status, then the path, or both paths of a rename. */
function parseNames(out: string): { path: string; oldPath?: string; change: FileDiff["change"] }[] {
  const fields = out.split("\0");
  const names: { path: string; oldPath?: string; change: FileDiff["change"] }[] = [];
  for (let i = 0; i + 1 < fields.length; ) {
    const status = fields[i++]!;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[i++]!;
      names.push({ path: fields[i++]!, oldPath, change: "modified" });
    } else names.push({ path: fields[i++]!, change: status === "A" ? "added" : status === "D" ? "deleted" : "modified" });
  }
  return names;
}
