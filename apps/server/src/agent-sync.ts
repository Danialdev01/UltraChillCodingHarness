import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { AGENT_DIR, refuseLink } from "./dev-database.js";

/**
 * Shared plumbing for the files the harness generates into `.agent/` from
 * what the app stores (the Tasks board, the Knowledge notes): a per-project
 * debounce, and writes that never go through a symlink and never leave a
 * half-written file for an agent to read.
 */

/** Runs `run(key)` once `delayMs` after the last `schedule(key)`; one run at a time per key. */
export class Debouncer {
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #again = new Set<string>();

  constructor(
    private readonly delayMs: number,
    private readonly run: (key: string) => Promise<void>,
    private readonly onError: (error: unknown, key: string) => void,
  ) {}

  schedule(key: string): void {
    clearTimeout(this.#timers.get(key));
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      void this.#fire(key);
    }, this.delayMs);
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  /** Runs now, waiting for a run already in flight; for the boot backfill and tests. */
  async flush(key: string): Promise<void> {
    clearTimeout(this.#timers.get(key));
    this.#timers.delete(key);
    await this.#fire(key);
  }

  async #fire(key: string): Promise<void> {
    const current = this.#running.get(key);
    if (current) {
      // A change landed mid-write: write once more after, with what is there then.
      this.#again.add(key);
      return current;
    }
    const job = (async () => {
      try {
        await this.run(key);
      } catch (error) {
        this.onError(error, key);
      }
    })();
    this.#running.set(key, job);
    try {
      await job;
    } finally {
      this.#running.delete(key);
    }
    if (this.#again.delete(key)) await this.#fire(key);
  }
}

/**
 * `.agent/<sub>` under a project root, refusing a symlink at any step: the
 * folder is in a tree the repository's author controls, and a link would
 * let a write land on a host file.
 */
export async function agentPath(root: string, sub: string): Promise<string> {
  const base = join(root, AGENT_DIR);
  const target = join(base, sub);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.split(sep)[0] !== AGENT_DIR) throw new Error(`${sub} is outside .agent`);
  let at = root;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    await refuseLink(at);
  }
  return target;
}

/** Writes `content` to `path` (already checked by `agentPath`) via a temp file; untouched when unchanged. */
export async function writeIfChanged(path: string, content: string | Buffer): Promise<boolean> {
  const current = await readFile(path).catch(() => null);
  const next = typeof content === "string" ? Buffer.from(content) : content;
  if (current && current.equals(next)) return false;
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, next);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return true;
}

/** Whether the project has a checkout to write into: `.agent/` is created with it, never before. */
export async function hasCheckout(root: string): Promise<boolean> {
  return lstat(join(root, ".git")).then(
    () => true,
    () => false,
  );
}

/** A name safe as one path segment: no separators, no dot-files, bounded. */
export function safeSegment(name: string, fallback: string): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** A lowercase, dash-separated slug for a file name. */
export function slugify(title: string, fallback: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}
