import { join, relative, sep } from "node:path";
import watcher from "@parcel/watcher";

/**
 * Files changed on disk by anything but the server's own file routes and
 * the agent -- a terminal, a dev server, a hand edit, `git checkout` --
 * reach everyone looking at the project as `file.changed`, so the file tree,
 * an open file and the Git view keep up without a refresh.
 *
 * A tree is watched only while someone has it open (`retain` / `release`,
 * driven by the WebSocket's project subscriptions) and for a minute after,
 * so a project nobody is looking at costs nothing. A tree is the project's
 * checkout, or one session's worktree by the session's hash. The native
 * watcher (inotify on Linux) reports changes in bursts; they are coalesced
 * per tree, and writes the server just announced itself are not echoed. A
 * burst of more than `maxBurst` paths -- an install, a build -- is one
 * notice (`publishMany`) rather than thousands of events.
 *
 * While any of a project's trees is watched, so is its repository: the
 * checkout's `.git`, which holds every worktree's `HEAD` and index too. A
 * commit, a checkout, a fetch from a terminal changes nothing outside it,
 * and the Git view hears of it through `onGitChange`.
 */

export type FileChange = "added" | "modified" | "deleted";

export interface FileWatcherOptions {
  /** The folder of the project's checkout (`tree` null), or of a session's worktree. */
  rootOf(projectId: string, tree: string | null): string;
  publish(projectId: string, path: string, change: FileChange, tree: string | null): void;
  /** More than `maxBurst` paths changed in one burst: one notice for them all. */
  publishMany(projectId: string, tree: string | null): void;
  /** The repository changed under `.git`: `HEAD`, the index, a ref, a fetch. */
  onGitChange?(projectId: string): void;
  /** Injected by tests. */
  subscribe?: typeof watcher.subscribe;
  /** Coalescing window. */
  burstMs?: number;
  /** How long after the last viewer leaves a tree stays watched. */
  lingerMs?: number;
  /** The most paths a burst reports one by one. 200 when absent. */
  maxBurst?: number;
  onError?(error: unknown): void;
}

/** Never worth a notice: version control internals, dependencies, build output. */
const IGNORE = [
  "**/.git",
  "**/.git/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/.next/**",
  "**/dist/**",
  "**/.ucch/cache/**",
];

/** Inside `.git`: what changes all the time and says nothing about the repository's state. */
const GIT_IGNORE = ["objects/**", "logs/**", "**/*.lock"];

/**
 * What in `.git` the Git view shows: the checked-out branch, the index, the
 * refs, the last fetch -- the checkout's and each worktree's.
 */
export function isGitStatePath(path: string): boolean {
  return (
    path === "HEAD" ||
    path === "index" ||
    path === "packed-refs" ||
    path === "FETCH_HEAD" ||
    path.startsWith("refs/") ||
    /^worktrees\/[^/]+\/(HEAD|index)$/.test(path)
  );
}

/** How long a path the server announced itself is not reported again. */
const ECHO_MS = 2000;

interface Watched {
  projectId: string;
  tree: string | null;
  viewers: number;
  subscription: Promise<watcher.AsyncSubscription | null>;
  pending: Map<string, FileChange>;
  timer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
}

interface GitWatch {
  /** The project's trees being watched; the repository is watched while any is. */
  trees: number;
  subscription: Promise<watcher.AsyncSubscription | null>;
  timer: NodeJS.Timeout | null;
}

export class FileWatcher {
  /** By `projectId` and tree. */
  readonly #watched = new Map<string, Watched>();
  readonly #git = new Map<string, GitWatch>();
  /** `${projectId}\0${tree}\0${path}` -> until when it is the server's own write. */
  readonly #recent = new Map<string, number>();

  constructor(private readonly options: FileWatcherOptions) {}

  /** Someone opened the project's checkout, or with `tree` one session's worktree. */
  retain(projectId: string, tree: string | null = null): void {
    const key = keyOf(projectId, tree);
    const entry = this.#watched.get(key);
    if (entry) {
      entry.viewers++;
      if (entry.stopTimer) clearTimeout(entry.stopTimer);
      entry.stopTimer = null;
      return;
    }
    const watched: Watched = {
      projectId,
      tree,
      viewers: 1,
      subscription: Promise.resolve(null),
      pending: new Map(),
      timer: null,
      stopTimer: null,
    };
    this.#watched.set(key, watched);
    watched.subscription = this.#watchTree(key, watched);
    this.#retainGit(projectId);
  }

  /**
   * The project's folders may exist now -- it was cloned, a session's
   * worktree was added: a watch that found nothing to watch tries again.
   */
  rearm(projectId: string): void {
    for (const [key, watched] of this.#watched) {
      if (watched.projectId !== projectId) continue;
      watched.subscription = watched.subscription.then(
        (subscription) => subscription ?? (this.#watched.get(key) === watched ? this.#watchTree(key, watched) : null),
      );
    }
    const git = this.#git.get(projectId);
    if (git) {
      git.subscription = git.subscription.then(
        (subscription) => subscription ?? (this.#git.get(projectId) === git ? this.#watchGit(projectId, git) : null),
      );
    }
  }

  /** Someone closed it; the last one out stops the watch after a while. */
  release(projectId: string, tree: string | null = null): void {
    const key = keyOf(projectId, tree);
    const entry = this.#watched.get(key);
    if (!entry) return;
    entry.viewers = Math.max(0, entry.viewers - 1);
    if (entry.viewers > 0 || entry.stopTimer) return;
    entry.stopTimer = setTimeout(() => this.#stop(key), this.options.lingerMs ?? 60_000);
    entry.stopTimer.unref?.();
  }

  /** The server wrote (and announced) this path itself: do not report it again. */
  noteOwnWrite(projectId: string, path: string, tree: string | null = null): void {
    const now = Date.now();
    this.#recent.set(`${keyOf(projectId, tree)}\0${path}`, now + ECHO_MS);
    if (this.#recent.size > 5000) {
      for (const [key, until] of this.#recent) if (until < now) this.#recent.delete(key);
    }
  }

  /** Projects with any tree watched. */
  get watchedProjects(): number {
    return this.#git.size;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#watched.keys()].map((key) => this.#stop(key)));
  }

  /** Watches `root`, handing each batch on as paths relative to it. A folder not there yet is no error. */
  #subscribe(
    root: string,
    onPaths: (paths: Array<[string, FileChange]>) => void,
    ignore: string[],
  ): Promise<watcher.AsyncSubscription | null> {
    return (this.options.subscribe ?? watcher.subscribe)(
      root,
      (error, events) => {
        if (error) {
          this.options.onError?.(error);
          return;
        }
        const paths: Array<[string, FileChange]> = [];
        for (const event of events) {
          const path = relative(root, event.path).split(sep).join("/");
          if (!path || path.startsWith("..")) continue;
          paths.push([path, event.type === "create" ? "added" : event.type === "delete" ? "deleted" : "modified"]);
        }
        if (paths.length > 0) onPaths(paths);
      },
      { ignore },
    ).catch((error: unknown) => {
      // A project not cloned yet has no folder to watch; that is not an error.
      this.options.onError?.(error);
      return null;
    });
  }

  #retainGit(projectId: string): void {
    const existing = this.#git.get(projectId);
    if (existing) {
      existing.trees++;
      return;
    }
    const watch: GitWatch = { trees: 1, subscription: Promise.resolve(null), timer: null };
    this.#git.set(projectId, watch);
    watch.subscription = this.#watchGit(projectId, watch);
  }

  #watchTree(key: string, watched: Watched): Promise<watcher.AsyncSubscription | null> {
    return this.#subscribe(
      this.options.rootOf(watched.projectId, watched.tree),
      (paths) => {
        for (const [path, next] of paths) watched.pending.set(path, merge(watched.pending.get(path), next));
        if (!watched.timer) watched.timer = setTimeout(() => this.#flush(key), this.options.burstMs ?? 150);
      },
      IGNORE,
    );
  }

  #watchGit(projectId: string, watch: GitWatch): Promise<watcher.AsyncSubscription | null> {
    return this.#subscribe(
      join(this.options.rootOf(projectId, null), ".git"),
      (paths) => {
        if (!paths.some(([path]) => isGitStatePath(path)) || watch.timer) return;
        watch.timer = setTimeout(() => {
          watch.timer = null;
          this.options.onGitChange?.(projectId);
        }, this.options.burstMs ?? 150);
      },
      GIT_IGNORE,
    );
  }

  async #releaseGit(projectId: string): Promise<void> {
    const watch = this.#git.get(projectId);
    if (!watch || --watch.trees > 0) return;
    this.#git.delete(projectId);
    if (watch.timer) clearTimeout(watch.timer);
    await (await watch.subscription)?.unsubscribe().catch(() => {});
  }

  #flush(key: string): void {
    const entry = this.#watched.get(key);
    if (!entry) return;
    entry.timer = null;
    const now = Date.now();
    const changed: Array<[string, FileChange]> = [];
    for (const [path, change] of entry.pending) {
      const until = this.#recent.get(`${key}\0${path}`);
      if (until !== undefined && until >= now) continue;
      changed.push([path, change]);
    }
    entry.pending.clear();
    if (changed.length > (this.options.maxBurst ?? 200)) {
      this.options.publishMany(entry.projectId, entry.tree);
      return;
    }
    for (const [path, change] of changed) this.options.publish(entry.projectId, path, change, entry.tree);
  }

  async #stop(key: string): Promise<void> {
    const entry = this.#watched.get(key);
    if (!entry) return;
    this.#watched.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    await Promise.all([
      (await entry.subscription)?.unsubscribe().catch(() => {}),
      this.#releaseGit(entry.projectId),
    ]);
  }
}

function keyOf(projectId: string, tree: string | null): string {
  return `${projectId}\0${tree ?? ""}`;
}

/**
 * Two changes to one path inside a burst, as one: a file created then
 * written is still new; one that was there, deleted and recreated, changed.
 */
function merge(before: FileChange | undefined, after: FileChange): FileChange {
  if (before === "added" && after === "modified") return "added";
  if (before === "deleted" && after === "added") return "modified";
  return after;
}
