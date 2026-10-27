import { randomBytes } from "node:crypto";

/**
 * The Git view's reads -- whether the tree is a repository, its status, its
 * branches, the first page of its log -- once per working tree, for every
 * viewer of it.
 *
 * Each viewer used to run them itself: on opening the view, every minute,
 * and 300 ms after every change to a file. A status is three git processes
 * and the three reads together seven, so ten people looking at one project
 * while the agent wrote turned every burst of edits into seventy. Here a
 * read is computed once and kept until something says it changed:
 *
 * - a file changing (`file.changed`) changes the status, nothing else;
 * - a commit, a push, or any git action through the routes changes them all;
 * - and nothing is kept longer than `maxAgeMs`, for what nobody announced.
 *
 * Nothing is recomputed until someone asks. Two who ask at once share the
 * one computation. After an invalidation the project's viewers are told,
 * once per burst however many changes came, that their git state is stale
 * (`onInvalidated`): `debounceMs` after the last change, or `maxWaitMs`
 * after the first while changes keep coming. Told sooner, a burst -- an
 * agent writing twenty files -- made every viewer read twice: the OS
 * watcher hands over a burst's first change at once and the rest together
 * once writing stops, and that gap alone came to almost half a second. The
 * state itself is never pushed, since a status
 * can list thousands of files and a project's topic reaches every quiet
 * subscriber.
 *
 * Each read has a version, new with every invalidation, which the routes
 * send as its `ETag`: a viewer that already has the current one is
 * answered 304 without git being run at all.
 */
export type GitRead = "isRepo" | "status" | "branches" | "log";

const ALL: readonly GitRead[] = ["isRepo", "status", "branches", "log"];

/** What a change to files invalidates: the status, and nothing a commit would. */
export const FILE_READS: readonly GitRead[] = ["status"];

/** The most working trees kept; the least recently read goes first. */
const MAX_TREES = 500;

export interface GitCacheOptions {
  /** Told, once per burst of changes, that a project's git state is stale. */
  onInvalidated(projectId: string): void;
  /** How long a read is kept with nothing to say it changed. 5 minutes when absent. */
  maxAgeMs?: number;
  /** Quiet this long after a change before viewers are told. 500 ms when absent. */
  debounceMs?: number;
  /** The longest viewers wait while changes keep coming. 1 s when absent. */
  maxWaitMs?: number;
  now?: () => number;
}

interface Slot {
  version: number;
  /** When `value` was asked for; meaningless until then. */
  at: number;
  value?: Promise<unknown>;
}

interface Tree {
  projectId: string;
  reads: Map<GitRead, Slot>;
}

export class GitCache {
  /** By working-tree directory, least recently read first. */
  readonly #trees = new Map<string, Tree>();
  /** By project: the notice waiting to go, and when the first change it covers came. */
  readonly #pending = new Map<string, { timer: ReturnType<typeof setTimeout>; since: number }>();
  /**
   * Different on every boot, so an `ETag` a browser kept from before a
   * restart never matches a version counted again from 1.
   */
  readonly #boot = randomBytes(4).toString("hex");
  #version = 0;
  readonly #options: GitCacheOptions;
  readonly #maxAgeMs: number;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #now: () => number;

  constructor(options: GitCacheOptions) {
    this.#options = options;
    this.#maxAgeMs = options.maxAgeMs ?? 5 * 60_000;
    this.#debounceMs = options.debounceMs ?? 500;
    this.#maxWaitMs = options.maxWaitMs ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The read for the tree in `dir`, computed by `compute` unless it is kept
   * and fresh, with the `ETag` of its version. A computation that fails is
   * not kept.
   */
  async read<T>(projectId: string, dir: string, read: GitRead, compute: () => Promise<T>): Promise<{ value: T; etag: string }> {
    const tree = this.#tree(projectId, dir);
    let slot = tree.reads.get(read);
    if (!slot || (slot.value && this.#now() - slot.at > this.#maxAgeMs)) {
      slot = { version: ++this.#version, at: 0 };
      tree.reads.set(read, slot);
    }
    if (!slot.value) {
      const current = slot;
      current.at = this.#now();
      const value = compute();
      current.value = value;
      value.catch(() => {
        if (current.value === value) delete current.value;
      });
    }
    const etag = this.#etag(slot.version);
    return { value: (await slot.value) as T, etag };
  }

  /**
   * The `ETag` a viewer holding the current version of the read would send,
   * or null when nothing current is kept -- never computed, invalidated, or
   * too old -- and the read has to run.
   */
  etag(dir: string, read: GitRead): string | null {
    const slot = this.#trees.get(dir)?.reads.get(read);
    if (!slot?.value || this.#now() - slot.at > this.#maxAgeMs) return null;
    return this.#etag(slot.version);
  }

  /**
   * Forgets the reads of every tree of the project -- its checkout and its
   * sessions' worktrees, which share its refs -- and tells its viewers.
   */
  invalidate(projectId: string, reads: readonly GitRead[] = ALL): void {
    for (const tree of this.#trees.values()) {
      if (tree.projectId !== projectId) continue;
      for (const read of reads) {
        if (tree.reads.has(read)) tree.reads.set(read, { version: ++this.#version, at: 0 });
      }
    }
    // The wall clock, as the timers keep it -- not `now`, which tests move by
    // hand for the reads' ages. A clock jump only shortens one wait.
    const at = Date.now();
    const pending = this.#pending.get(projectId);
    if (pending) clearTimeout(pending.timer);
    const since = pending?.since ?? at;
    const timer = setTimeout(
      () => {
        this.#pending.delete(projectId);
        this.#options.onInvalidated(projectId);
      },
      Math.max(0, Math.min(this.#debounceMs, since + this.#maxWaitMs - at)),
    );
    timer.unref?.();
    this.#pending.set(projectId, { timer, since });
  }

  /** Stops the pending notices: shutdown and tests. */
  dispose(): void {
    for (const { timer } of this.#pending.values()) clearTimeout(timer);
    this.#pending.clear();
  }

  #tree(projectId: string, dir: string): Tree {
    let tree = this.#trees.get(dir);
    if (tree) {
      // To the back: the least recently read tree is the first let go.
      this.#trees.delete(dir);
    } else {
      tree = { projectId, reads: new Map() };
      if (this.#trees.size >= MAX_TREES) this.#trees.delete(this.#trees.keys().next().value!);
    }
    this.#trees.set(dir, tree);
    return tree;
  }

  #etag(version: number): string {
    return `"${this.#boot}.${version}"`;
  }
}
