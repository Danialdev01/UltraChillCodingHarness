import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { runGit } from "./git-exec.js";
import { GitService } from "./git.js";
import { SessionBusyError, SessionLifecycle, SessionUnsavedError, type SessionRecord } from "./session-lifecycle.js";
import { projectRoot, sessionTree } from "./trees.js";

const PROJECT = "55555555-5555-5555-5555-555555555555";
const HASH = "s3ss10nhash0";
const AUTHOR = { name: "Test", email: "test@example.com" };
const IDENTITY = ["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`];

let root: string;
let repo: string;
let tree: string;
let turns: number;
let deleted: string[];
let announced: DomainEvent[];
let lifecycle: SessionLifecycle;

const sh = (argv: string[], cwd = repo) => runGit([...IDENTITY, ...argv], cwd, 20_000);
const exists = (path: string) => stat(path).then(() => true, () => false);

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "66666666-6666-6666-6666-666666666666",
    projectId: PROJECT,
    hash: HASH,
    title: "Fix the thing",
    status: "idle",
    branch: `ucch/${HASH}`,
    baseBranch: "main",
    worktreeState: "ready",
    ...overrides,
  };
}

async function addOrigin(): Promise<string> {
  const origin = join(root, "origin.git");
  await runGit(["init", "-q", "--bare", "-b", "main", origin], root, 20_000);
  await sh(["remote", "add", "origin", origin]);
  await sh(["push", "-q", "-u", "origin", "main"]);
  return origin;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-lifecycle-"));
  repo = projectRoot(root, PROJECT);
  tree = sessionTree(root, PROJECT, HASH);
  await mkdir(repo, { recursive: true });
  await sh(["init", "-q", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "hello\n");
  await sh(["add", "-A"]);
  await sh(["commit", "-q", "--no-verify", "-m", "init"]);
  await mkdir(join(root, ".worktrees", PROJECT), { recursive: true });
  await sh(["worktree", "add", "-q", "-b", `ucch/${HASH}`, tree, "main"]);

  turns = 0;
  deleted = [];
  announced = [];
  lifecycle = new SessionLifecycle({
    git: new GitService(root),
    workspaceRoot: root,
    turnCount: async () => turns,
    deleteThread: async (id) => void deleted.push(id),
    credentials: async () => ({ token: null, author: AUTHOR }),
    announce: async (_projectId, event) => void announced.push(event),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("removeIfEmpty", () => {
  it("removes a session with nothing in it, worktree and branch too", async () => {
    expect(await lifecycle.removeIfEmpty(session())).toBe(true);
    expect(deleted).toHaveLength(1);
    expect(await exists(tree)).toBe(false);
    expect(await sh(["branch", "--list", `ucch/${HASH}`])).toBe("");
    expect(announced).toEqual([expect.objectContaining({ type: "thread.removed", hash: HASH, pushedBranch: null })]);
  });

  it("keeps a session that has had a conversation", async () => {
    turns = 1;
    expect(await lifecycle.removeIfEmpty(session())).toBe(false);
    expect(deleted).toEqual([]);
    expect(await exists(tree)).toBe(true);
  });

  it("keeps a session with an edit or a commit", async () => {
    await writeFile(join(tree, "new.txt"), "work\n");
    expect(await lifecycle.removeIfEmpty(session())).toBe(false);

    await sh(["add", "-A"], tree);
    await sh(["commit", "-q", "--no-verify", "-m", "work"], tree);
    expect(await lifecycle.removeIfEmpty(session())).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("keeps a running session", async () => {
    expect(await lifecycle.removeIfEmpty(session({ status: "running" }))).toBe(false);
  });

  it("removes an empty session in the main checkout without touching it", async () => {
    await writeFile(join(repo, "dirty.txt"), "the project's own edit\n");
    const main = session({ branch: null, baseBranch: null, worktreeState: null });
    expect(await lifecycle.removeIfEmpty(main)).toBe(true);
    expect(await exists(join(repo, "dirty.txt"))).toBe(true);
  });
});

describe("settle", () => {
  it("refuses while the agent works", async () => {
    await expect(lifecycle.settle(session({ status: "running" }))).rejects.toBeInstanceOf(SessionBusyError);
    expect(deleted).toEqual([]);
  });

  it("keeps a session with changes when there is nowhere to push them", async () => {
    await writeFile(join(tree, "new.txt"), "work\n");
    await expect(lifecycle.settle(session())).rejects.toBeInstanceOf(SessionUnsavedError);
    expect(deleted).toEqual([]);
    expect(await exists(join(tree, "new.txt"))).toBe(true);
  });

  it("commits and pushes the session's work, then removes it", async () => {
    const origin = await addOrigin();
    await writeFile(join(tree, "new.txt"), "work\n");

    expect(await lifecycle.settle(session())).toEqual({ pushed: `ucch/${HASH}` });
    const onOrigin = await runGit(["show", `ucch/${HASH}:new.txt`], origin, 20_000);
    expect(onOrigin).toBe("work\n");
    const message = await runGit(["log", "-1", "--format=%s", `ucch/${HASH}`], origin, 20_000);
    expect(message.trim()).toBe("Session: Fix the thing");
    expect(deleted).toHaveLength(1);
    expect(await exists(tree)).toBe(false);
  });

  it("pushes commits that origin does not have yet", async () => {
    const origin = await addOrigin();
    await writeFile(join(tree, "a.txt"), "a\n");
    await sh(["add", "-A"], tree);
    await sh(["commit", "-q", "--no-verify", "-m", "agent commit"], tree);

    expect(await lifecycle.settle(session())).toEqual({ pushed: `ucch/${HASH}` });
    expect((await runGit(["log", "-1", "--format=%s", `ucch/${HASH}`], origin, 20_000)).trim()).toBe("agent commit");
  });

  it("removes a session with no changes without pushing anything", async () => {
    const origin = await addOrigin();
    turns = 3;
    expect(await lifecycle.settle(session())).toEqual({ pushed: null });
    expect(await runGit(["branch", "--list", `ucch/${HASH}`], origin, 20_000)).toBe("");
    expect(deleted).toHaveLength(1);
  });
});
