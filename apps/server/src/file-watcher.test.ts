import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileWatcher, isGitStatePath, type FileChange } from "./file-watcher.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const TREE = "abc123def456";
let root: string;
let heard: { path: string; change: FileChange; tree?: string }[];
let many: (string | null)[];
let gitChanges: number;
let watcher: FileWatcher;

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-watch-"));
  await mkdir(join(root, PROJECT, "node_modules"), { recursive: true });
  await mkdir(join(root, PROJECT, ".git", "refs", "heads"), { recursive: true });
  await mkdir(join(root, PROJECT, ".git", "objects"), { recursive: true });
  await mkdir(join(root, ".worktrees", PROJECT, TREE), { recursive: true });
  heard = [];
  many = [];
  gitChanges = 0;
  watcher = new FileWatcher({
    rootOf: (id, tree) => (tree ? join(root, ".worktrees", id, tree) : join(root, id)),
    publish: (_id, path, change, tree) => heard.push({ path, change, ...(tree ? { tree } : {}) }),
    publishMany: (_id, tree) => many.push(tree),
    onGitChange: () => gitChanges++,
    burstMs: 200,
    lingerMs: 50,
    maxBurst: 5,
  });
});

afterEach(async () => {
  await watcher.closeAll();
  await rm(root, { recursive: true, force: true });
});

describe("FileWatcher", () => {
  it("reports a file written by anyone while the project is open", async () => {
    watcher.retain(PROJECT);
    await settle(300);
    await writeFile(join(root, PROJECT, "foo.txt"), "x");
    await settle();
    expect(heard).toContainEqual({ path: "foo.txt", change: "added" });
  });

  it("ignores dependencies and the server's own writes", async () => {
    watcher.retain(PROJECT);
    await settle(300);
    watcher.noteOwnWrite(PROJECT, "mine.txt");
    await writeFile(join(root, PROJECT, "mine.txt"), "x");
    await writeFile(join(root, PROJECT, "node_modules", "dep.js"), "x");
    await settle();
    expect(heard).toEqual([]);
  });

  it("stops watching once nobody has the project open", async () => {
    watcher.retain(PROJECT);
    await settle(300);
    watcher.release(PROJECT);
    await settle(200);
    expect(watcher.watchedProjects).toBe(0);
    await writeFile(join(root, PROJECT, "late.txt"), "x");
    await settle();
    expect(heard).toEqual([]);
  });

  it("reports a session's worktree as its own tree", async () => {
    watcher.retain(PROJECT, TREE);
    await settle(300);
    await writeFile(join(root, ".worktrees", PROJECT, TREE, "wt.txt"), "x");
    await settle();
    expect(heard).toContainEqual({ path: "wt.txt", change: "added", tree: TREE });
    expect(heard.every((h) => h.tree === TREE)).toBe(true);
  });

  it("hears a commit or a checkout through .git, and nothing else in it", async () => {
    watcher.retain(PROJECT);
    await settle(300);
    await writeFile(join(root, PROJECT, ".git", "objects", "ab"), "x");
    await writeFile(join(root, PROJECT, ".git", "index.lock"), "x");
    await settle();
    expect(gitChanges).toBe(0);
    await writeFile(join(root, PROJECT, ".git", "HEAD"), "ref: refs/heads/main");
    await settle();
    // A slow disk may split one write's events over two bursts.
    const afterHead = gitChanges;
    expect(afterHead).toBeGreaterThan(0);
    await writeFile(join(root, PROJECT, ".git", "refs", "heads", "main"), "x");
    await settle();
    expect(gitChanges).toBeGreaterThan(afterHead);
    expect(heard).toEqual([]);
  });

  it("watches the repository once while any of the project's trees is open", async () => {
    watcher.retain(PROJECT);
    watcher.retain(PROJECT, TREE);
    expect(watcher.watchedProjects).toBe(1);
    watcher.release(PROJECT);
    await settle(200);
    expect(watcher.watchedProjects).toBe(1);
    watcher.release(PROJECT, TREE);
    await settle(200);
    expect(watcher.watchedProjects).toBe(0);
  });

  it("turns a burst of more than maxBurst paths into one notice", async () => {
    watcher.retain(PROJECT);
    await settle(300);
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(join(root, PROJECT, `f${i}.txt`), "x")));
    await settle();
    expect(many).toContain(null);
    expect(heard.length).toBeLessThan(20);
  });
});

describe("FileWatcher.rearm", () => {
  it("watches a session's worktree that did not exist when it was opened", async () => {
    const late = "fff000fff000";
    watcher.retain(PROJECT, late);
    await settle(300);
    await mkdir(join(root, ".worktrees", PROJECT, late), { recursive: true });
    watcher.rearm(PROJECT);
    await settle(300);
    await writeFile(join(root, ".worktrees", PROJECT, late, "new.txt"), "x");
    await settle();
    expect(heard).toContainEqual({ path: "new.txt", change: "added", tree: late });
    expect(heard.every((h) => h.tree === late)).toBe(true);
  });
});

describe("isGitStatePath", () => {
  it("knows what in .git the Git view shows", () => {
    for (const path of ["HEAD", "index", "packed-refs", "FETCH_HEAD", "refs/heads/main", "refs/remotes/origin/x", "worktrees/abc/HEAD", "worktrees/abc/index"]) {
      expect(isGitStatePath(path)).toBe(true);
    }
    for (const path of ["config", "ORIG_HEAD.lock", "objects/ab/cd", "logs/HEAD", "worktrees/abc/logs/HEAD", "hooks/pre-commit"]) {
      expect(isGitStatePath(path)).toBe(false);
    }
  });
});
