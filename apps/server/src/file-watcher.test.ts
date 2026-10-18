import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileWatcher, type FileChange } from "./file-watcher.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
let root: string;
let heard: { path: string; change: FileChange }[];
let watcher: FileWatcher;

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-watch-"));
  await mkdir(join(root, PROJECT, "node_modules"), { recursive: true });
  heard = [];
  watcher = new FileWatcher({
    rootOf: (id) => join(root, id),
    publish: (_id, path, change) => heard.push({ path, change }),
    burstMs: 50,
    lingerMs: 50,
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
});
