import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TurnSnapshots } from "./turn-snapshot.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
let root: string;
let tree: string;
const git = (...argv: string[]) => execFileSync("git", argv, { cwd: tree, encoding: "utf8" });
const put = (path: string, text: string | Buffer) => writeFileSync(join(tree, path), text);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ucch-snap-"));
  tree = join(root, PROJECT);
  mkdirSync(tree);
  git("init", "-q");
  put(".gitignore", "ignored.txt\n");
  put("edit.txt", "one\ntwo\n");
  put("gone.txt", "bye\n");
  put("move.txt", Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n"));
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("TurnSnapshots", () => {
  it("tells edits, new files, deletes, renames and binaries, and leaves git alone", async () => {
    const index = readFileSync(join(tree, ".git/index"));
    const snapshots = new TurnSnapshots(root);
    const before = (await snapshots.capture(PROJECT, tree))!;
    execFileSync("sed", ["-i", "s/two/2/", "edit.txt"], { cwd: tree });
    put("né w.txt", "hi\n");
    put("ignored.txt", "no");
    put(".env", "SECRET=1");
    put("pic.bin", Buffer.from([0, 1, 2, 0]));
    rmSync(join(tree, "gone.txt"));
    renameSync(join(tree, "move.txt"), join(tree, "moved.txt"));
    const { files, omitted } = await snapshots.changes(PROJECT, tree, before);
    expect(omitted).toBe(0);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(["edit.txt", "gone.txt", "moved.txt", "né w.txt", "pic.bin"].sort());
    expect(by["edit.txt"]!.patch).toContain("-two\n+2");
    expect(by["né w.txt"]).toMatchObject({ change: "added", added: 1 });
    expect(by["gone.txt"]).toMatchObject({ change: "deleted", removed: 1 });
    expect(by["moved.txt"]).toMatchObject({ oldPath: "move.txt" });
    expect(by["pic.bin"]!.patch).toBe("");
    expect(readFileSync(join(tree, ".git/index")).equals(index)).toBe(true);
  });

  it("runs no filter of the repository's", async () => {
    git("config", "filter.evil.clean", "touch pwned; cat");
    put(".gitattributes", "* filter=evil\n");
    put("edit.txt", "changed\n");
    await new TurnSnapshots(root).capture(PROJECT, tree);
    expect(existsSync(join(tree, "pwned"))).toBe(false);
  });

  it("has nothing to say of an unchanged tree, or of a folder without git", async () => {
    const snapshots = new TurnSnapshots(root);
    const before = (await snapshots.capture(PROJECT, tree))!;
    expect(await snapshots.changes(PROJECT, tree, before)).toEqual({ files: [], omitted: 0 });
    rmSync(join(tree, ".git"), { recursive: true });
    expect(await snapshots.capture(PROJECT, tree)).toBeNull();
  });
});
