import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "./git-exec.js";
import { GitService } from "./git.js";
import { projectDeletionCheck } from "./project-deletion.js";
import { projectRoot, sessionTree } from "./trees.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
let root: string;
let repo: string;
let git: GitService;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-delete-"));
  repo = projectRoot(root, PROJECT);
  await mkdir(repo);
  await runGit(["init", "-b", "main"], repo, 10_000);
  await writeFile(join(repo, "file.txt"), "initial\n");
  git = new GitService(root);
  await git.stage(PROJECT, "all");
  await git.commit(PROJECT, { summary: "initial" }, { name: "Test", email: "test@example.com" });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("project deletion check", () => {
  it("allows a clean project, including clean session worktrees", async () => {
    const tree = sessionTree(root, PROJECT, "session00001");
    await mkdir(join(root, ".worktrees", PROJECT), { recursive: true });
    await runGit(["worktree", "add", "-b", "session", tree], repo, 10_000);
    expect(await projectDeletionCheck(root, PROJECT, git)).toEqual({ trees: [] });
  });

  it("finds staged, unstaged and untracked changes across the checkout and session trees", async () => {
    const tree = sessionTree(root, PROJECT, "session00001");
    await mkdir(join(root, ".worktrees", PROJECT), { recursive: true });
    await runGit(["worktree", "add", "-b", "session", tree], repo, 10_000);
    await writeFile(join(repo, "file.txt"), "staged\n");
    await git.stage(PROJECT, "all");
    await writeFile(join(repo, "new.txt"), "untracked\n");
    await writeFile(join(tree, "file.txt"), "unstaged\n");
    expect(await projectDeletionCheck(root, PROJECT, git)).toEqual({ trees: [
      { session: null, changes: 2, canCommit: true },
      { session: "session00001", changes: 1, canCommit: true },
    ] });
    // Committing first is explicit and keeps the files available until deletion.
    for (const target of [PROJECT, { projectId: PROJECT, tree }]) {
      await git.stage(target, "all");
      await git.commit(target, { summary: "saved" }, { name: "Test", email: "test@example.com" });
    }
    expect(await projectDeletionCheck(root, PROJECT, git)).toEqual({ trees: [] });
  });

  it("warns about files in a directory that has no repository", async () => {
    await rm(join(repo, ".git"), { recursive: true, force: true });
    expect(await projectDeletionCheck(root, PROJECT, git)).toEqual({ trees: [
      { session: null, changes: 1, canCommit: false },
    ] });
  });

  it("accepts a missing checkout after an interrupted clone", async () => {
    await rm(repo, { recursive: true, force: true });
    expect(await projectDeletionCheck(root, PROJECT, git)).toEqual({ trees: [] });
  });
});
