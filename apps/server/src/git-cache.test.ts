import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILE_READS, GitCache } from "./git-cache.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const OTHER = "55555555-5555-5555-5555-555555555555";
const CHECKOUT = "/work/p";
const SESSION = "/work/.worktrees/p/s1";

describe("GitCache", () => {
  let now: number;
  let notified: string[];
  let cache: GitCache;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    notified = [];
    cache = new GitCache({ onInvalidated: (projectId) => notified.push(projectId), maxAgeMs: 1_000, debounceMs: 300, now: () => now });
  });
  afterEach(() => {
    cache.dispose();
    vi.useRealTimers();
  });

  /** A computation that counts its runs and answers with the count. */
  const counter = () => {
    let runs = 0;
    const compute = vi.fn(async () => ++runs);
    return compute;
  };

  it("runs a read once for everyone who asks at the same time", async () => {
    let finish!: (value: string) => void;
    const compute = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const reads = [1, 2, 3].map(() => cache.read(PROJECT, CHECKOUT, "status", compute));
    finish("clean");
    const answers = await Promise.all(reads);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(new Set(answers.map((a) => a.etag)).size).toBe(1);
    expect(answers.map((a) => a.value)).toEqual(["clean", "clean", "clean"]);
  });

  it("keeps a read until it is invalidated, then runs it again under a new version", async () => {
    const compute = counter();
    const first = await cache.read(PROJECT, CHECKOUT, "status", compute);
    expect((await cache.read(PROJECT, CHECKOUT, "status", compute)).value).toBe(1);
    expect(cache.etag(CHECKOUT, "status")).toBe(first.etag);
    cache.invalidate(PROJECT);
    expect(cache.etag(CHECKOUT, "status")).toBeNull();
    const second = await cache.read(PROJECT, CHECKOUT, "status", compute);
    expect(second.value).toBe(2);
    expect(second.etag).not.toBe(first.etag);
  });

  it("lets a change to files go stale only the status, in every tree of the project", async () => {
    const reads = { status: counter(), branches: counter(), log: counter(), session: counter(), other: counter() };
    await cache.read(PROJECT, CHECKOUT, "status", reads.status);
    await cache.read(PROJECT, CHECKOUT, "branches", reads.branches);
    await cache.read(PROJECT, CHECKOUT, "log", reads.log);
    await cache.read(PROJECT, SESSION, "status", reads.session);
    await cache.read(OTHER, "/work/o", "status", reads.other);
    cache.invalidate(PROJECT, FILE_READS);
    await cache.read(PROJECT, CHECKOUT, "status", reads.status);
    await cache.read(PROJECT, CHECKOUT, "branches", reads.branches);
    await cache.read(PROJECT, CHECKOUT, "log", reads.log);
    await cache.read(PROJECT, SESSION, "status", reads.session);
    await cache.read(OTHER, "/work/o", "status", reads.other);
    expect(Object.values(reads).map((compute) => compute.mock.calls.length)).toEqual([2, 1, 1, 2, 1]);
  });

  it("runs a read again once it is older than the most it may be kept", async () => {
    const compute = counter();
    const first = await cache.read(PROJECT, CHECKOUT, "branches", compute);
    now = 1_001;
    expect(cache.etag(CHECKOUT, "branches")).toBeNull();
    const second = await cache.read(PROJECT, CHECKOUT, "branches", compute);
    expect(second.value).toBe(2);
    expect(second.etag).not.toBe(first.etag);
  });

  it("does not keep a read that failed", async () => {
    const compute = vi.fn().mockRejectedValueOnce(new Error("index.lock")).mockResolvedValueOnce("clean");
    await expect(cache.read(PROJECT, CHECKOUT, "status", compute)).rejects.toThrow("index.lock");
    expect(cache.etag(CHECKOUT, "status")).toBeNull();
    expect((await cache.read(PROJECT, CHECKOUT, "status", compute)).value).toBe("clean");
  });

  it("hands a read invalidated while it ran to those already waiting, and no one after", async () => {
    let finish!: (value: string) => void;
    const slow = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const waiting = cache.read(PROJECT, CHECKOUT, "status", slow);
    cache.invalidate(PROJECT);
    const fresh = cache.read(PROJECT, CHECKOUT, "status", async () => "fresh");
    finish("old");
    expect((await waiting).value).toBe("old");
    expect((await fresh).value).toBe("fresh");
  });

  it("tells a project's viewers once per window however many changes came", async () => {
    cache.invalidate(PROJECT, FILE_READS);
    cache.invalidate(PROJECT, FILE_READS);
    cache.invalidate(OTHER);
    expect(notified).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(notified).toEqual([PROJECT, OTHER]);
    cache.invalidate(PROJECT);
    vi.advanceTimersByTime(300);
    expect(notified).toEqual([PROJECT, OTHER, PROJECT]);
  });
});
