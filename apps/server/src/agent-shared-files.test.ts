import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SharedAgentFiles, withSharedAgentFilesAside } from "./agent-shared-files.js";
import { projectRoot, sessionTree } from "./trees.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ME = ["-c", "user.name=t", "-c", "user.email=t@t"];

let root: string;
let main: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...ME, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const runner = (cwd: string) => async (argv: string[]) => git(cwd, ...argv);
const tree = (hash: string) => sessionTree(root, PROJECT, hash);
const read = (dir: string, file: string) => readFile(join(dir, ".agent", file), "utf8").catch(() => null);
const put = async (dir: string, file: string, content: string) => {
  await mkdir(join(dir, ".agent"), { recursive: true });
  await writeFile(join(dir, ".agent", file), content);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-shared-"));
  main = projectRoot(root, PROJECT);
  await mkdir(main);
  git(main, "init", "-q", "-b", "main");
  await writeFile(join(main, "README.md"), "# p\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  for (const hash of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) git(main, "worktree", "add", "-q", "-b", `ucch/${hash}`, tree(hash));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the project's commands and variables in session worktrees", () => {
  it("copies a project save into every worktree, the vault staying private", async () => {
    const mirror = new SharedAgentFiles({ workspaceRoot: root });
    await put(main, "commands.json", '{"commands":[]}\n');
    await put(main, "env.val", '{"vault":1}\n');
    await mirror.fromProject(PROJECT);
    for (const hash of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) {
      expect(await read(tree(hash), "commands.json")).toBe('{"commands":[]}\n');
      expect(await read(tree(hash), "env.val")).toBe('{"vault":1}\n');
      expect((await stat(join(tree(hash), ".agent", "env.val"))).mode & 0o777).toBe(0o600);
    }
  });

  it("makes a worktree's edit the project's and the other sessions', and says so", async () => {
    const onProjectChanged = vi.fn();
    const mirror = new SharedAgentFiles({ workspaceRoot: root, onProjectChanged });
    await put(tree("aaaaaaaaaaaa"), "commands.json", '{"commands":["from a"]}\n');
    await mirror.fromTree(PROJECT, "aaaaaaaaaaaa", "commands.json");
    expect(await read(main, "commands.json")).toBe('{"commands":["from a"]}\n');
    expect(await read(tree("bbbbbbbbbbbb"), "commands.json")).toBe('{"commands":["from a"]}\n');
    expect(onProjectChanged).toHaveBeenCalledWith(PROJECT, "commands.json");
  });

  it("does not let the late echo of an earlier save overwrite a newer one", async () => {
    const mirror = new SharedAgentFiles({ workspaceRoot: root });
    await put(main, "commands.json", "v1\n");
    await mirror.fromProject(PROJECT);
    await put(main, "commands.json", "v2\n");
    // The watcher of worktree b reports the v1 copy after v2 was saved.
    await put(tree("bbbbbbbbbbbb"), "commands.json", "v1\n");
    await mirror.fromTree(PROJECT, "bbbbbbbbbbbb", "commands.json");
    expect(await read(main, "commands.json")).toBe("v2\n");
  });

  it("removes the copies when the project's file goes, never the other way round", async () => {
    const mirror = new SharedAgentFiles({ workspaceRoot: root });
    await put(main, "env.val", "vault\n");
    await mirror.fromProject(PROJECT);
    await rm(join(tree("aaaaaaaaaaaa"), ".agent", "env.val"));
    await mirror.fromTree(PROJECT, "aaaaaaaaaaaa", "env.val");
    expect(await read(main, "env.val")).toBe("vault\n");

    await rm(join(main, ".agent", "env.val"));
    await mirror.fromProject(PROJECT);
    expect(await read(tree("bbbbbbbbbbbb"), "env.val")).toBeNull();
  });

  it("seeds a new worktree, and catches up on edits nobody was watching, the newer copy winning", async () => {
    const mirror = new SharedAgentFiles({ workspaceRoot: root });
    await put(main, "commands.json", "project\n");
    await mirror.seed(PROJECT, "aaaaaaaaaaaa");
    expect(await read(tree("aaaaaaaaaaaa"), "commands.json")).toBe("project\n");

    await put(tree("aaaaaaaaaaaa"), "commands.json", "edited unwatched\n");
    const later = new Date(Date.now() + 60_000);
    await utimes(join(tree("aaaaaaaaaaaa"), ".agent", "commands.json"), later, later);
    await new SharedAgentFiles({ workspaceRoot: root }).reconcile(PROJECT, "aaaaaaaaaaaa");
    expect(await read(main, "commands.json")).toBe("edited unwatched\n");
    expect(await read(tree("bbbbbbbbbbbb"), "commands.json")).toBe("edited unwatched\n");
  });

  it("refuses to follow a symlinked .agent in a worktree", async () => {
    const errors: unknown[] = [];
    const mirror = new SharedAgentFiles({ workspaceRoot: root, onError: (e) => errors.push(e) });
    const outside = join(root, "outside");
    await mkdir(outside);
    execFileSync("ln", ["-s", outside, join(tree("aaaaaaaaaaaa"), ".agent")]);
    await put(main, "commands.json", "x\n");
    await mirror.fromProject(PROJECT);
    expect(await readdir(outside)).toEqual([]);
    expect(await read(tree("bbbbbbbbbbbb"), "commands.json")).toBe("x\n");
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("git operations over the project's uncommitted copies", () => {
  it("merges a branch that committed them, keeping the project's live versions", async () => {
    const wt = tree("aaaaaaaaaaaa");
    await put(wt, "commands.json", "branch version\n");
    await put(wt, "env.val", "branch vault\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "session");
    await put(main, "commands.json", "live version\n");
    await put(main, "env.val", "live vault\n");
    // Plain git refuses: the untracked files would be overwritten.
    expect(() => git(main, "merge", "-q", "--no-edit", "ucch/aaaaaaaaaaaa")).toThrow();

    await withSharedAgentFilesAside(main, runner(main), async () => git(main, "merge", "-q", "--no-edit", "ucch/aaaaaaaaaaaa"));
    expect(git(main, "log", "-1", "--format=%s").trim()).toBe("session");
    expect(await read(main, "commands.json")).toBe("live version\n");
    expect(await read(main, "env.val")).toBe("live vault\n");
    expect((await readdir(join(main, ".agent", "cache")))).toEqual([]);
  });

  it("puts them back when the operation fails", async () => {
    await put(main, "env.val", "live vault\n");
    await expect(
      withSharedAgentFilesAside(main, runner(main), async () => {
        throw new Error("merge failed");
      }),
    ).rejects.toThrow("merge failed");
    expect(await read(main, "env.val")).toBe("live vault\n");
  });

  it("leaves committed, unchanged copies alone", async () => {
    await put(main, "commands.json", "committed\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "c");
    let during: string | null = "unread";
    await withSharedAgentFilesAside(main, runner(main), async () => {
      during = await read(main, "commands.json");
    });
    expect(during).toBe("committed\n");
  });
});
