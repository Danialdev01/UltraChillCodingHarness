import { relative, sep } from "node:path";
import watcher from "@parcel/watcher";

/**
 * Files changed on disk by anything but the server's own file routes and
 * the agent -- a terminal, a dev server, a hand edit, `git checkout` --
 * reach everyone looking at the project as `file.changed`, so the file tree,
 * an open file and the Git view keep up without a refresh.
 *
 * A project is watched only while someone has it open (`retain` / `release`,
 * driven by the WebSocket's project subscriptions) and for a minute after,
 * so a project nobody is looking at costs nothing. The native watcher
 * (inotify on Linux) reports changes in bursts; they are coalesced per
 * project, and writes the server just announced itself are not echoed.
 */

export type FileChange = "added" | "modified" | "deleted";

export interface FileWatcherOptions {
  /** The project's folder on disk. */
  rootOf(projectId: string): string;
  publish(projectId: string, path: string, change: FileChange): void;
  /** Injected by tests. */
  subscribe?: typeof watcher.subscribe;
  /** Coalescing window. */
  burstMs?: number;
  /** How long after the last viewer leaves a project stays watched. */
  lingerMs?: number;
  onError?(error: unknown): void;
}

/** Never worth a notice: version control internals, dependencies, build output. */
const IGNORE = ["**/.git/**", "**/node_modules/**", "**/vendor/**", "**/.next/**", "**/dist/**", "**/.ucch/cache/**"];

/** How long a path the server announced itself is not reported again. */
const ECHO_MS = 2000;

interface Watched {
  viewers: number;
  subscription: Promise<watcher.AsyncSubscription | null>;
  pending: Map<string, FileChange>;
  timer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
}

export class FileWatcher {
  readonly #watched = new Map<string, Watched>();
  /** `${projectId}\0${path}` -> until when it is the server's own write. */
  readonly #recent = new Map<string, number>();

  constructor(private readonly options: FileWatcherOptions) {}

  /** Someone opened the project. */
  retain(projectId: string): void {
    const entry = this.#watched.get(projectId);
    if (entry) {
      entry.viewers++;
      if (entry.stopTimer) clearTimeout(entry.stopTimer);
      entry.stopTimer = null;
      return;
    }
    const watched: Watched = { viewers: 1, subscription: Promise.resolve(null), pending: new Map(), timer: null, stopTimer: null };
    this.#watched.set(projectId, watched);
    const root = this.options.rootOf(projectId);
    watched.subscription = (this.options.subscribe ?? watcher.subscribe)(
      root,
      (error, events) => {
        if (error) {
          this.options.onError?.(error);
          return;
        }
        for (const event of events) {
          const path = relative(root, event.path).split(sep).join("/");
          if (!path || path.startsWith("..")) continue;
          const next: FileChange = event.type === "create" ? "added" : event.type === "delete" ? "deleted" : "modified";
          watched.pending.set(path, merge(watched.pending.get(path), next));
        }
        if (!watched.timer) watched.timer = setTimeout(() => this.#flush(projectId), this.options.burstMs ?? 150);
      },
      { ignore: IGNORE },
    ).catch((error: unknown) => {
      // A project not cloned yet has no folder to watch; that is not an error.
      this.options.onError?.(error);
      return null;
    });
  }

  /** Someone closed it; the last one out stops the watch after a while. */
  release(projectId: string): void {
    const entry = this.#watched.get(projectId);
    if (!entry) return;
    entry.viewers = Math.max(0, entry.viewers - 1);
    if (entry.viewers > 0 || entry.stopTimer) return;
    entry.stopTimer = setTimeout(() => this.#stop(projectId), this.options.lingerMs ?? 60_000);
    entry.stopTimer.unref?.();
  }

  /** The server wrote (and announced) this path itself: do not report it again. */
  noteOwnWrite(projectId: string, path: string): void {
    const now = Date.now();
    this.#recent.set(`${projectId}\0${path}`, now + ECHO_MS);
    if (this.#recent.size > 5000) {
      for (const [key, until] of this.#recent) if (until < now) this.#recent.delete(key);
    }
  }

  get watchedProjects(): number {
    return this.#watched.size;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.#watched.keys()].map((id) => this.#stop(id)));
  }

  #flush(projectId: string): void {
    const entry = this.#watched.get(projectId);
    if (!entry) return;
    entry.timer = null;
    const now = Date.now();
    for (const [path, change] of entry.pending) {
      const until = this.#recent.get(`${projectId}\0${path}`);
      if (until !== undefined && until >= now) continue;
      this.options.publish(projectId, path, change);
    }
    entry.pending.clear();
  }

  async #stop(projectId: string): Promise<void> {
    const entry = this.#watched.get(projectId);
    if (!entry) return;
    this.#watched.delete(projectId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    await (await entry.subscription)?.unsubscribe().catch(() => {});
  }
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
