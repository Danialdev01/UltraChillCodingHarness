import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { runGit } from "./git-exec.js";
import { GitService } from "./git.js";
import type { SettleOutcome } from "./project-git.js";
import { SessionBusyError, SessionLifecycle, type ProjectSettleSettings, type SessionRecord } from "./session-lifecycle.js";
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
let sharers: { count: number; running: boolean };
let settings: ProjectSettleSettings;
let marked: SettleOutcome[];

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
  sharers = { count: 0, running: false };
  deleted = [];
  announced = [];
  marked = [];
  settings = { baseBranch: "main", autoPushBase: false, deleteBranchOnSettle: true };
  lifecycle = new SessionLifecycle({
    git: new GitService(root),
    workspaceRoot: root,
    projectSettings: async () => settings,
    markSettled: async (_session, outcome) => void marked.push(outcome),
    turnCount: async () => turns,
    sharers: async () => sharers,
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
  const log = (ref: string, format = "%s") => sh(["log", "-1", `--format=${format}`, ref]).then((o) => o.trim());

  it("refuses while the agent works", async () => {
    await expect(lifecycle.settle(session({ status: "running" }))).rejects.toBeInstanceOf(SessionBusyError);
    expect(deleted).toEqual([]);
  });

  it("commits what was left uncommitted and merges it into the base, with no remote at all", async () => {
    await writeFile(join(tree, "new.txt"), "work\n");

    const result = await lifecycle.settle(session());
    expect(result).toMatchObject({ state: "settled", baseBranch: "main" });
    const sha = (result as { mergeCommitSha: string }).mergeCommitSha;
    expect(await log("main", "%H")).toBe(sha);
    expect(await log("main", "%P")).toContain(" "); // a merge commit: two parents
    expect(await sh(["show", "main:new.txt"])).toBe("work\n");
    expect(await log(`${sha}^2`)).toBe("Settle session: Fix the thing");
    // The row stays, marked; the worktree and branch go.
    expect(deleted).toEqual([]);
    expect(marked).toEqual([expect.objectContaining({ state: "settled", mergeCommitSha: sha })]);
    expect(await exists(tree)).toBe(false);
    expect(await sh(["branch", "--list", `ucch/${HASH}`])).toBe("");
    expect(announced).toEqual([
      expect.objectContaining({ type: "thread.settled", state: "settled", baseBranch: "main", mergeCommitSha: sha }),
    ]);
  });

  it("keeps the branch when the project says so", async () => {
    settings.deleteBranchOnSettle = false;
    await writeFile(join(tree, "new.txt"), "work\n");
    await lifecycle.settle(session());
    expect(await exists(tree)).toBe(false);
    expect(await sh(["branch", "--list", `ucch/${HASH}`])).toContain(`ucch/${HASH}`);
  });

  it("brings the base up to origin first, and pushes it only when asked", async () => {
    const origin = await addOrigin();
    // Someone else moved origin/main on.
    const other = join(root, "other");
    await runGit(["clone", "-q", origin, other], root, 20_000);
    await writeFile(join(other, "theirs.txt"), "theirs\n");
    await runGit([...IDENTITY, "add", "-A"], other, 20_000);
    await runGit([...IDENTITY, "commit", "-q", "--no-verify", "-m", "theirs"], other, 20_000);
    await runGit(["push", "-q", "origin", "main"], other, 20_000);

    await writeFile(join(tree, "mine.txt"), "mine\n");
    const result = await lifecycle.settle(session());
    expect(result).toMatchObject({ state: "settled", pushed: false });
    expect(await sh(["show", "main:theirs.txt"])).toBe("theirs\n");
    expect(await sh(["show", "main:mine.txt"])).toBe("mine\n");
    // Not pushed: origin is where the other clone left it.
    expect((await runGit(["log", "-1", "--format=%s", "main"], origin, 20_000)).trim()).toBe("theirs");
  });

  it("pushes the base after merging when auto-push is on", async () => {
    const origin = await addOrigin();
    settings.autoPushBase = true;
    await writeFile(join(tree, "mine.txt"), "mine\n");
    const result = await lifecycle.settle(session());
    expect(result).toMatchObject({ state: "settled", pushed: true, pushError: null });
    expect((await runGit(["rev-parse", "main"], origin, 20_000)).trim()).toBe(
      (result as { mergeCommitSha: string }).mergeCommitSha,
    );
  });

  it("aborts a conflicting merge, leaving the base, the worktree and the branch as they were", async () => {
    await writeFile(join(tree, "README.md"), "the session's\n");
    await writeFile(join(repo, "README.md"), "the base's\n");
    await sh(["commit", "-q", "--no-verify", "-am", "base moved"]);
    const before = await log("main", "%H");

    const result = await lifecycle.settle(session());
    expect(result).toMatchObject({ state: "failed", baseBranch: "main", conflicts: ["README.md"] });
    expect(await log("main", "%H")).toBe(before);
    expect(await exists(join(repo, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await sh(["status", "--porcelain"])).toBe("");
    expect(await exists(tree)).toBe(true);
    expect(await sh(["branch", "--list", `ucch/${HASH}`])).toContain(`ucch/${HASH}`);
    expect(marked).toEqual([expect.objectContaining({ state: "failed", conflicts: ["README.md"] })]);
    expect(deleted).toEqual([]);
  });

  it("removes a session with no worktree of its own, as before", async () => {
    turns = 3;
    const main = session({ branch: null, baseBranch: null, worktreeState: null });
    expect(await lifecycle.settle(main)).toEqual({ state: "removed" });
    expect(deleted).toHaveLength(1);
  });
});

describe("discard", () => {
  it("drops the session's edits and commits, with its worktree and branch, and pushes nothing", async () => {
    const origin = await addOrigin();
    await writeFile(join(tree, "a.txt"), "a\n");
    await sh(["add", "-A"], tree);
    await sh(["commit", "-q", "--no-verify", "-m", "agent commit"], tree);
    await writeFile(join(tree, "b.txt"), "uncommitted\n");

    await lifecycle.discard(session());
    expect(deleted).toHaveLength(1);
    expect(await exists(tree)).toBe(false);
    expect(await sh(["branch", "--list", `ucch/${HASH}`])).toBe("");
    expect(await runGit(["branch", "--list", `ucch/${HASH}`], origin, 20_000)).toBe("");
    // The project's own checkout is untouched.
    expect(await sh(["log", "-1", "--format=%s"])).toBe("init\n");
    expect(announced).toEqual([expect.objectContaining({ type: "thread.removed", hash: HASH, pushedBranch: null })]);
  });

  it("works with no remote at all", async () => {
    await writeFile(join(tree, "new.txt"), "work\n");
    await lifecycle.discard(session());
    expect(deleted).toHaveLength(1);
    expect(await exists(tree)).toBe(false);
  });

  it("refuses while the agent works, or the session it was handed to does", async () => {
    await expect(lifecycle.discard(session({ status: "running" }))).rejects.toBeInstanceOf(SessionBusyError);
    sharers = { count: 1, running: true };
    await expect(lifecycle.discard(session())).rejects.toBeInstanceOf(SessionBusyError);
    expect(deleted).toEqual([]);
    expect(await exists(tree)).toBe(true);
  });
});

describe("a worktree two sessions share (a handoff)", () => {
  const handedTo = () => session({ id: "77777777-7777-7777-7777-777777777777", hash: "n3wsess10n00", treeHash: HASH });

  it("works the new session in the old one's folder", async () => {
    await writeFile(join(tree, "work.txt"), "the old session's edit\n");
    // The same folder, so the same edit.
    expect(await lifecycle.inspect(handedTo())).toMatchObject({ dirty: true });
  });

  it("keeps the worktree and branch while another session works in it", async () => {
    turns = 2;
    sharers = { count: 1, running: false };
    await writeFile(join(tree, "work.txt"), "work\n");
    // The old session settles: its row goes, the folder and its work stay.
    expect(await lifecycle.settle(session())).toEqual({ state: "removed" });
    expect(deleted).toEqual([session().id]);
    expect(await exists(join(tree, "work.txt"))).toBe(true);
    expect(await sh(["branch", "--list", `ucch/${HASH}`])).toContain(`ucch/${HASH}`);

    // The last one out merges it and takes them.
    sharers = { count: 0, running: false };
    expect(await lifecycle.settle(handedTo())).toMatchObject({ state: "settled" });
    expect(await sh(["show", "main:work.txt"])).toBe("work\n");
    expect(await exists(tree)).toBe(false);
    expect(await sh(["branch", "--list", `ucch/${HASH}`])).toBe("");
  });

  it("refuses to settle while the session it was handed to is working", async () => {
    turns = 1;
    sharers = { count: 1, running: true };
    await expect(lifecycle.settle(session())).rejects.toBeInstanceOf(SessionBusyError);
    expect(deleted).toEqual([]);
  });

  it("removes an empty one's row without its partner's folder", async () => {
    sharers = { count: 1, running: false };
    expect(await lifecycle.removeIfEmpty(handedTo())).toBe(true);
    expect(await exists(tree)).toBe(true);
  });
});
