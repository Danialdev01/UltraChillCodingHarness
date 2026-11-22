import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentPath, writeIfChanged } from "./agent-sync.js";
import { projectRoot, sessionTree, sessionTreesOf } from "./trees.js";

/**
 * The files in `.agent/` that belong to the project, not to a branch: the
 * command buttons and the encrypted environment variables. Both are saved to
 * the project's checkout, and every session worktree holds a live copy, so
 * the Files view of a session shows what the header and the Environment
 * Variables section show, and the agent working there can read them.
 *
 * The copies are kept in step both ways: a save in the project reaches every
 * worktree, and an edit made in a worktree (by hand, by the agent) becomes
 * the project's and every other session's. A deletion only travels from the
 * project outwards: a worktree's copy disappearing is also what removing the
 * worktree looks like, and must not wipe the project's.
 */
export const SHARED_AGENT_FILES = ["commands.json", "env.val"] as const;
export type SharedAgentFile = (typeof SHARED_AGENT_FILES)[number];

/** Repository paths of the shared files. */
export const SHARED_AGENT_PATHS = SHARED_AGENT_FILES.map((file) => `.agent/${file}`);

/** A pathspec for "everything but the shared files", for status and add. */
export const WITHOUT_SHARED_AGENT_FILES = [".", ...SHARED_AGENT_PATHS.map((path) => `:(exclude)${path}`)];

/** The vault stays private wherever it is copied to. */
const MODE: Record<SharedAgentFile, number | undefined> = { "commands.json": undefined, "env.val": 0o600 };

/** Larger than either file can legitimately be (the vault caps at 16 MB). */
const MAX_BYTES = 16 * 1024 * 1024;

/** The shared file a repository path is, or null. */
export function sharedAgentFileOf(path: string): SharedAgentFile | null {
  return SHARED_AGENT_FILES.find((file) => path === `.agent/${file}`) ?? null;
}

interface Copy {
  content: Buffer;
  mtimeMs: number;
}

/** Absent: null. A symlink anywhere on the way, or not a plain file: "refused". */
async function readCopy(root: string, file: SharedAgentFile): Promise<Copy | null | "refused"> {
  let path: string;
  try {
    path = await agentPath(root, file);
  } catch {
    return "refused";
  }
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (!info.isFile() || info.size > MAX_BYTES) return "refused";
  const content = await readFile(path).catch(() => null);
  return content ? { content, mtimeMs: info.mtimeMs } : null;
}

async function writeCopy(root: string, file: SharedAgentFile, content: Buffer): Promise<boolean> {
  return writeIfChanged(await agentPath(root, file), content, MODE[file]);
}

async function removeCopy(root: string, file: SharedAgentFile): Promise<void> {
  await rm(await agentPath(root, file), { force: true });
}

const digest = (content: Buffer) => createHash("sha256").update(content).digest("hex");

async function hasGit(dir: string): Promise<boolean> {
  return lstat(join(dir, ".git")).then(
    () => true,
    () => false,
  );
}

export interface SharedAgentFilesOptions {
  workspaceRoot: string;
  /** The project's copy was replaced from a worktree's. */
  onProjectChanged?(projectId: string, file: SharedAgentFile): Promise<void> | void;
  onError?(error: unknown): void;
  /** How long a copy this class wrote is recognised as its own echo. */
  echoMs?: number;
}

export class SharedAgentFiles {
  readonly #chains = new Map<string, Promise<void>>();
  /** `${projectId}\0${file}` -> digests written recently, and until when. */
  readonly #written = new Map<string, Map<string, number>>();

  constructor(private readonly options: SharedAgentFilesOptions) {}

  /** The project's copy changed (or went): every session worktree follows. */
  fromProject(projectId: string): Promise<void> {
    return this.#serial(projectId, async () => {
      for (const file of SHARED_AGENT_FILES) await this.#push(projectId, file, await this.#trees(projectId), true);
    });
  }

  /** A worktree's copy changed: it becomes the project's, and every other session's. */
  fromTree(projectId: string, treeHash: string, file: SharedAgentFile): Promise<void> {
    return this.#serial(projectId, async () => {
      const copy = await readCopy(sessionTree(this.options.workspaceRoot, projectId, treeHash), file);
      if (!copy || copy === "refused" || this.#isEcho(projectId, file, copy.content)) return;
      await this.#adopt(projectId, file, copy.content);
    });
  }

  /** A new worktree starts from the project's copies, not from whatever its branch committed. */
  seed(projectId: string, treeHash: string): Promise<void> {
    return this.#serial(projectId, async () => {
      for (const file of SHARED_AGENT_FILES) await this.#push(projectId, file, [treeHash], false);
    });
  }

  /**
   * Someone opened a tree (`treeHash`), or the project's checkout (null):
   * catches up with edits made while nobody was watching, the newer copy
   * winning.
   */
  reconcile(projectId: string, treeHash: string | null): Promise<void> {
    return this.#serial(projectId, async () => {
      const root = projectRoot(this.options.workspaceRoot, projectId);
      const trees = treeHash ? [treeHash] : await this.#trees(projectId);
      for (const file of SHARED_AGENT_FILES) {
        const project = await readCopy(root, file);
        if (project === "refused") continue;
        let newest: Copy | null = null;
        for (const hash of trees) {
          const copy = await readCopy(sessionTree(this.options.workspaceRoot, projectId, hash), file);
          if (!copy || copy === "refused" || (project && copy.content.equals(project.content))) continue;
          if (this.#isEcho(projectId, file, copy.content)) continue;
          if (project && copy.mtimeMs <= project.mtimeMs) continue;
          if (!newest || copy.mtimeMs > newest.mtimeMs) newest = copy;
        }
        if (newest) await this.#adopt(projectId, file, newest.content);
        else await this.#push(projectId, file, trees, false);
      }
    });
  }

  /** Waits for every pending copy; for tests and shutdown. */
  async drain(): Promise<void> {
    await Promise.all([...this.#chains.values()].map((chain) => chain.catch(() => {})));
  }

  async #adopt(projectId: string, file: SharedAgentFile, content: Buffer): Promise<void> {
    const root = projectRoot(this.options.workspaceRoot, projectId);
    if (!(await hasGit(root))) return;
    this.#remember(projectId, file, content);
    if (await writeCopy(root, file, content)) await this.options.onProjectChanged?.(projectId, file);
    await this.#push(projectId, file, await this.#trees(projectId), false);
  }

  /** The project's copy into `trees`; with `deletes`, its absence too. */
  async #push(projectId: string, file: SharedAgentFile, trees: readonly string[], deletes: boolean): Promise<void> {
    const project = await readCopy(projectRoot(this.options.workspaceRoot, projectId), file);
    if (project === "refused" || (!project && !deletes)) return;
    if (project) this.#remember(projectId, file, project.content);
    for (const hash of trees) {
      const tree = sessionTree(this.options.workspaceRoot, projectId, hash);
      try {
        if (!(await hasGit(tree))) continue;
        if (project) await writeCopy(tree, file, project.content);
        else await removeCopy(tree, file);
      } catch (error) {
        // One worktree with a symlinked `.agent` does not stop the others.
        this.options.onError?.(error);
      }
    }
  }

  /** The project's session worktrees by hash; not the temporary settle checkouts. */
  async #trees(projectId: string): Promise<string[]> {
    const names = await readdir(sessionTreesOf(this.options.workspaceRoot, projectId)).catch(() => [] as string[]);
    return names.filter((name) => !name.startsWith(".")).sort();
  }

  #remember(projectId: string, file: SharedAgentFile, content: Buffer): void {
    const key = `${projectId}\0${file}`;
    const now = Date.now();
    const seen = this.#written.get(key) ?? new Map<string, number>();
    for (const [hash, until] of seen) if (until < now) seen.delete(hash);
    seen.set(digest(content), now + (this.options.echoMs ?? 10_000));
    this.#written.set(key, seen);
  }

  /**
   * A copy this class wrote moments ago, heard back from a worktree's
   * watcher. Without this, two quick saves would race: the echo of the first
   * arriving after the second would copy the older content back.
   */
  #isEcho(projectId: string, file: SharedAgentFile, content: Buffer): boolean {
    const until = this.#written.get(`${projectId}\0${file}`)?.get(digest(content));
    return until !== undefined && until >= Date.now();
  }

  #serial(projectId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(work, work).catch((error: unknown) => this.options.onError?.(error));
    this.#chains.set(projectId, next);
    void next.finally(() => {
      if (this.#chains.get(projectId) === next) this.#chains.delete(projectId);
    });
    return next;
  }
}

/** Runs git in one tree; okExitCodes as `runGit` takes them. */
type Git = (argv: string[], options?: { okExitCodes?: readonly number[]; read?: boolean }) => Promise<string>;

/**
 * Runs a git operation that may bring in another branch's version of the
 * shared files -- a settle's merge, a pull, a branch switch -- with this
 * tree's uncommitted copies moved out of its way, then puts them back.
 *
 * Git refuses to merge or switch over an untracked file the other side has,
 * even an identical one, and over a local modification it would overwrite.
 * The copies here are the project's live ones (the files are the project's,
 * not the branch's), so they are what the tree holds afterwards, whatever
 * the branch committed. They wait in `.agent/cache/`, so a crash mid-merge
 * leaves them recoverable rather than gone.
 */
export async function withSharedAgentFilesAside<T>(dir: string, git: Git, work: () => Promise<T>): Promise<T> {
  const aside: { file: SharedAgentFile; path: string; parked: string }[] = [];
  for (const file of SHARED_AGENT_FILES) {
    const rel = `.agent/${file}`;
    let path: string;
    try {
      path = await agentPath(dir, file);
    } catch {
      continue;
    }
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) continue;
    const status = (await git(["status", "--porcelain", "--untracked-files=all", "--", rel], { read: true })).trim();
    if (!status) continue;
    const parked = join(await agentPath(dir, "cache"), `aside-${file}-${randomBytes(4).toString("hex")}`);
    await mkdir(join(parked, ".."), { recursive: true });
    await rename(path, parked);
    aside.push({ file, path, parked });
    const inHead = await git(["ls-tree", "--name-only", "HEAD", "--", rel], { read: true })
      .then((out) => out.trim() !== "")
      .catch(() => false);
    if (inHead) await git(["checkout", "HEAD", "--", rel]);
    else await git(["rm", "--cached", "--quiet", "--ignore-unmatch", "--", rel]);
  }
  try {
    return await work();
  } finally {
    for (const { path, parked } of aside) {
      const now = await readFile(path).catch(() => null);
      const kept = await readFile(parked);
      if (now?.equals(kept)) await rm(parked, { force: true });
      else await rename(parked, path);
    }
  }
}
