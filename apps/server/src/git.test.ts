import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathError } from "./files.js";
import { GitError, runGit } from "./git-exec.js";
import { GitRefError, GitService, parseForEachRef, parseLog, parseNameStatusZ, parseStatusV2 } from "./git.js";

const PROJECT = "44444444-4444-4444-4444-444444444444";
const AUTHOR = { name: "Test", email: "test@example.com" };
const IDENTITY = ["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`];

let root: string;
let dir: string;
let git: GitService;

const sh = (argv: string[], cwd = dir) => runGit([...IDENTITY, ...argv], cwd, 20_000);

async function write(path: string, content: string, cwd = dir) {
  await mkdir(join(cwd, path, ".."), { recursive: true });
  await writeFile(join(cwd, path), content, "utf8");
}

async function commitAll(message: string, cwd = dir) {
  await sh(["add", "-A"], cwd);
  await sh(["commit", "--no-verify", "-q", "-m", message], cwd);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-git-"));
  dir = join(root, PROJECT);
  await mkdir(dir, { recursive: true });
  await sh(["init", "-q", "-b", "main"]);
  git = new GitService(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parseStatusV2", () => {
  it("reads the branch header and every entry kind", () => {
    const raw = [
      "# branch.oid abc",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
      "1 A. N... 000000 100644 100644 000 ccc new file.ts",
      "2 R. N... 100644 100644 100644 ddd ddd R100 renamed.ts\0old.ts",
      "u UU N... 100644 100644 100644 100644 eee fff ggg conflict.ts",
      "? notes.txt",
      "! ignored.log",
    ].join("\0");
    const parsed = parseStatusV2(raw + "\0");
    expect(parsed).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1, detached: false, unborn: false });
    expect(parsed.files).toEqual([
      { path: "src/a.ts", index: ".", worktree: "M", untracked: false, conflicted: false },
      { path: "new file.ts", index: "A", worktree: ".", untracked: false, conflicted: false },
      { path: "renamed.ts", origPath: "old.ts", index: "R", worktree: ".", untracked: false, conflicted: false },
      { path: "conflict.ts", index: "U", worktree: "U", untracked: false, conflicted: true, conflictKind: "UU" },
      { path: "notes.txt", index: ".", worktree: ".", untracked: true, conflicted: false },
    ]);
  });

  it("recognises a detached HEAD and an unborn branch", () => {
    expect(parseStatusV2("# branch.oid (initial)\0# branch.head main\0")).toMatchObject({ unborn: true, branch: "main" });
    expect(parseStatusV2("# branch.oid abc\0# branch.head (detached)\0")).toMatchObject({ detached: true, branch: null });
  });
});

describe("parseLog", () => {
  it("splits records and keeps a multi-line body", () => {
    const out = "aaa\0a\0p1 p2\0Ann\0ann@x\0" + "2025-01-01T00:00:00+00:00\0Subject\0line one\n\nline two\n\x1e\n" +
      "bbb\0b\0\0Bob\0bob@x\x002025-01-02T00:00:00+00:00\0Second\0\x1e\n";
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ sha: "aaa", parents: ["p1", "p2"], authorName: "Ann", subject: "Subject", body: "line one\n\nline two" });
    expect(commits[1]).toMatchObject({ sha: "bbb", parents: [], body: "" });
  });
});

describe("parseForEachRef", () => {
  it("separates local and remote branches and drops origin/HEAD", () => {
    const out = [
      "refs/heads/main\0abc\0origin/main\x002025-01-01T00:00:00+00:00\0*",
      "refs/heads/feature\0def\0\x002025-01-02T00:00:00+00:00\0 ",
      "refs/remotes/origin/HEAD\0abc\0\x002025-01-01T00:00:00+00:00\0 ",
      "refs/remotes/origin/main\0abc\0\x002025-01-01T00:00:00+00:00\0 ",
    ].join("\n");
    const list = parseForEachRef(out);
    expect(list.current).toBe("main");
    expect(list.local.map((b) => b.name)).toEqual(["main", "feature"]);
    expect(list.local[0]).toMatchObject({ upstream: "origin/main", current: true });
    expect(list.local[1]).toMatchObject({ upstream: null, current: false });
    expect(list.remote.map((b) => b.name)).toEqual(["origin/main"]);
  });
});

describe("parseNameStatusZ", () => {
  it("reads renames as two paths", () => {
    expect(parseNameStatusZ("M\0a.ts\0R090\0old.ts\0new.ts\0D\0gone.ts\0")).toEqual([
      { path: "a.ts", status: "M" },
      { path: "new.ts", origPath: "old.ts", status: "R" },
      { path: "gone.ts", status: "D" },
    ]);
  });
});

describe("status", () => {
  it("describes an empty repository", async () => {
    const status = await git.status(PROJECT);
    expect(status).toMatchObject({ branch: "main", unborn: true, files: [], hasRemote: false, mergeInProgress: false });
  });

  it("lists staged, unstaged and untracked changes", async () => {
    await write("a.ts", "one\n");
    await commitAll("init");
    await write("a.ts", "two\n");
    await write("b.ts", "new\n");
    await write("c.ts", "staged\n");
    await sh(["add", "c.ts"]);
    const { files } = await git.status(PROJECT);
    expect(files).toHaveLength(3);
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "a.ts", index: ".", worktree: "M" }),
        expect.objectContaining({ path: "b.ts", untracked: true }),
        expect.objectContaining({ path: "c.ts", index: "A", worktree: "." }),
      ]),
    );
  });
});

describe("stage, unstage, discard", () => {
  beforeEach(async () => {
    await write("a.ts", "one\n");
    await commitAll("init");
    await write("a.ts", "two\n");
    await write("b.ts", "new\n");
  });

  it("stages and unstages named paths", async () => {
    await git.stage(PROJECT, ["a.ts"]);
    let { files } = await git.status(PROJECT);
    expect(files.find((f) => f.path === "a.ts")).toMatchObject({ index: "M", worktree: "." });
    await git.unstage(PROJECT, ["a.ts"]);
    ({ files } = await git.status(PROJECT));
    expect(files.find((f) => f.path === "a.ts")).toMatchObject({ index: ".", worktree: "M" });
  });

  it("stages everything with `all`", async () => {
    await git.stage(PROJECT, "all");
    const { files } = await git.status(PROJECT);
    expect(files.every((f) => f.index !== "." && f.worktree === ".")).toBe(true);
  });

  it("unstages before the first commit", async () => {
    const fresh = join(root, "fresh");
    await mkdir(fresh);
    await sh(["init", "-q", "-b", "main"], fresh);
    await write("x.ts", "x\n", fresh);
    const service = new GitService(root);
    await service.stage("fresh", "all");
    expect((await service.status("fresh")).files[0]).toMatchObject({ index: "A" });
    await service.unstage("fresh", ["x.ts"]);
    expect((await service.status("fresh")).files[0]).toMatchObject({ untracked: true });
  });

  it("discards tracked changes and deletes untracked files", async () => {
    const changed = await git.discard(PROJECT, ["a.ts", "b.ts"]);
    expect(changed).toEqual(
      expect.arrayContaining([
        { path: "a.ts", change: "modified" },
        { path: "b.ts", change: "deleted" },
      ]),
    );
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("one\n");
    await expect(readFile(join(dir, "b.ts"))).rejects.toThrow();
    expect((await git.status(PROJECT)).files).toEqual([]);
  });

  it("refuses a path outside the project", async () => {
    await expect(git.stage(PROJECT, ["../escape"])).rejects.toThrow(PathError);
    await expect(git.diff(PROJECT, "/etc/passwd", "worktree")).rejects.toThrow(PathError);
  });
});

describe("diff", () => {
  it("shows a working-tree patch, a staged patch and an untracked file", async () => {
    await write("a.ts", "one\n");
    await commitAll("init");
    await write("a.ts", "two\n");
    await write("b.ts", "new\n");
    const worktree = await git.diff(PROJECT, "a.ts", "worktree");
    expect(worktree).toMatchObject({ conflict: false, binary: false });
    expect(worktree.conflict === false && worktree.patch).toContain("-one\n+two");
    await git.stage(PROJECT, ["a.ts"]);
    const index = await git.diff(PROJECT, "a.ts", "index");
    expect(index.conflict === false && index.patch).toContain("+two");
    const untracked = await git.diff(PROJECT, "b.ts", "untracked");
    expect(untracked.conflict === false && untracked.patch).toContain("+new");
  });

  it("flags a binary file", async () => {
    await write("a.bin", "x");
    await commitAll("init");
    await writeFile(join(dir, "a.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    const diff = await git.diff(PROJECT, "a.bin", "worktree");
    expect(diff).toMatchObject({ conflict: false, binary: true, patch: "" });
  });
});

describe("commit and log", () => {
  it("returns an empty page before the first commit", async () => {
    expect(await git.log(PROJECT)).toEqual({ commits: [], hasMore: false, isShallow: false });
  });

  it("commits staged changes under the given identity and lists them", async () => {
    await write("a.ts", "one\n");
    await git.stage(PROJECT, "all");
    const { sha, branch } = await git.commit(PROJECT, { summary: "Add a", description: "Why not.\n" }, AUTHOR);
    expect(branch).toBe("main");
    const page = await git.log(PROJECT, { limit: 10 });
    expect(page.commits).toHaveLength(1);
    expect(page.commits[0]).toMatchObject({ sha, subject: "Add a", body: "Why not.", authorName: "Test", authorEmail: "test@example.com" });
    const detail = await git.show(PROJECT, sha);
    expect(detail.files).toEqual([{ path: "a.ts", status: "A" }]);
    const diff = await git.commitDiff(PROJECT, sha, "a.ts");
    expect(diff.conflict === false && diff.patch).toContain("+one");
  });

  it("pages with hasMore", async () => {
    for (let i = 0; i < 3; i++) {
      await write("a.ts", `${i}\n`);
      await commitAll(`c${i}`);
    }
    const first = await git.log(PROJECT, { limit: 2 });
    expect(first.commits.map((c) => c.subject)).toEqual(["c2", "c1"]);
    expect(first.hasMore).toBe(true);
    const second = await git.log(PROJECT, { skip: 2, limit: 2 });
    expect(second.commits.map((c) => c.subject)).toEqual(["c0"]);
    expect(second.hasMore).toBe(false);
  });

  it("fails with nothing to commit", async () => {
    await write("a.ts", "one\n");
    await commitAll("init");
    await expect(git.commit(PROJECT, { summary: "empty" }, AUTHOR)).rejects.toThrow(GitError);
  });

  it("rejects a malformed sha", async () => {
    await expect(git.show(PROJECT, "--output=x")).rejects.toThrow(GitRefError);
  });
});

describe("branches", () => {
  beforeEach(async () => {
    await write("a.ts", "one\n");
    await commitAll("init");
  });

  it("creates, lists and switches branches, reporting changed paths", async () => {
    await git.createBranch(PROJECT, "feature");
    await write("f.ts", "feature\n");
    await commitAll("feature work");
    let list = await git.branches(PROJECT);
    expect(list.current).toBe("feature");
    expect(list.local.map((b) => b.name).sort()).toEqual(["feature", "main"]);

    const changed = await git.checkout(PROJECT, "main");
    expect(changed).toEqual([{ path: "f.ts", change: "deleted" }]);
    list = await git.branches(PROJECT);
    expect(list.current).toBe("main");
  });

  it("refuses a branch name that looks like an option", async () => {
    await expect(git.createBranch(PROJECT, "--force")).rejects.toThrow(GitRefError);
    await expect(git.checkout(PROJECT, "a..b")).rejects.toThrow(GitRefError);
  });
});

describe("conflicts", () => {
  beforeEach(async () => {
    await write("a.ts", "base\n");
    await commitAll("init");
    await sh(["switch", "-q", "-c", "other"]);
    await write("a.ts", "theirs\n");
    await commitAll("theirs");
    await sh(["switch", "-q", "main"]);
    await write("a.ts", "ours\n");
    await commitAll("ours");
    await runGit([...IDENTITY, "merge", "other"], dir, 20_000, { okExitCodes: [0, 1] });
  });

  it("reports the merge and the conflicted file with its markers", async () => {
    const status = await git.status(PROJECT);
    expect(status.mergeInProgress).toBe(true);
    expect(status.files).toEqual([expect.objectContaining({ path: "a.ts", conflicted: true, conflictKind: "UU" })]);
    const diff = await git.diff(PROJECT, "a.ts", "worktree");
    expect(diff.conflict).toBe(true);
    expect(diff.conflict && diff.content).toContain("<<<<<<<");
  });

  it("resolves with theirs and lets the merge commit", async () => {
    await git.resolve(PROJECT, "a.ts", "theirs");
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("theirs\n");
    const status = await git.status(PROJECT);
    expect(status.files.some((f) => f.conflicted)).toBe(false);
    expect(status.files[0]).toMatchObject({ path: "a.ts", index: "M" });
    await git.commit(PROJECT, { summary: "merge" }, AUTHOR);
    expect((await git.status(PROJECT)).mergeInProgress).toBe(false);
  });

  it("resolves with ours", async () => {
    await git.resolve(PROJECT, "a.ts", "ours");
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("ours\n");
  });

  it("shows a merge commit against its first parent", async () => {
    await git.resolve(PROJECT, "a.ts", "theirs");
    const { sha } = await git.commit(PROJECT, { summary: "merge" }, AUTHOR);
    const detail = await git.show(PROJECT, sha);
    expect(detail.commit.parents).toHaveLength(2);
    expect(detail.files).toEqual([{ path: "a.ts", status: "M" }]);
    const diff = await git.commitDiff(PROJECT, sha, "a.ts");
    expect(diff.conflict === false && diff.patch).toContain("-ours\n+theirs");
  });

  it("aborts the merge", async () => {
    const changed = await git.abortMerge(PROJECT);
    expect(changed).toEqual([{ path: "a.ts", change: "modified" }]);
    const status = await git.status(PROJECT);
    expect(status.mergeInProgress).toBe(false);
    expect(status.files).toEqual([]);
    expect(await readFile(join(dir, "a.ts"), "utf8")).toBe("ours\n");
  });
});

describe("with a remote", () => {
  let bare: string;
  const CLONE = "55555555-5555-5555-5555-555555555555";
  let clone: string;

  beforeEach(async () => {
    // A bare origin seeded from the working repo, then a shallow clone of it
    // the way `CloneReactor` makes one.
    await write("a.ts", "one\n");
    await commitAll("init");
    await write("a.ts", "two\n");
    await commitAll("second");
    bare = join(root, "origin.git");
    await runGit(["clone", "-q", "--bare", dir, bare], root, 20_000);
    clone = join(root, CLONE);
    await runGit(["clone", "-q", "--depth", "1", "--", `file://${bare}`, clone], root, 20_000);
  });

  it("knows the upstream, shallowness and last fetch", async () => {
    const status = await git.status(CLONE);
    expect(status).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, isShallow: true, hasRemote: true });
    expect((await git.log(CLONE)).commits).toHaveLength(1);
    await git.fetch(CLONE, null, { unshallow: true });
    const after = await git.status(CLONE);
    expect(after.isShallow).toBe(false);
    expect(after.lastFetchedAt).not.toBeNull();
    expect((await git.log(CLONE)).commits).toHaveLength(2);
  });

  it("counts ahead, pushes, and publishes a new branch", async () => {
    await write("b.ts", "b\n", clone);
    await commitAll("local", clone);
    expect((await git.status(CLONE)).ahead).toBe(1);
    const pushed = await git.push(CLONE, null);
    expect(pushed.branch).toBe("main");
    expect((await git.status(CLONE)).ahead).toBe(0);

    await git.createBranch(CLONE, "topic");
    expect((await git.status(CLONE)).upstream).toBeNull();
    await git.push(CLONE, null);
    expect((await git.status(CLONE)).upstream).toBe("origin/topic");
    const remote = (await git.branches(CLONE)).remote.map((b) => b.name);
    expect(remote).toContain("origin/topic");
  });

  it("counts behind and pulls", async () => {
    await write("c.ts", "c\n");
    await commitAll("upstream");
    await sh(["push", "-q", bare, "main"]);
    await git.fetch(CLONE, null);
    expect((await git.status(CLONE)).behind).toBe(1);
    const result = await git.pull(CLONE, null, AUTHOR);
    expect(result.conflicts).toBe(false);
    expect(result.changed).toEqual([{ path: "c.ts", change: "added" }]);
    expect((await git.status(CLONE)).behind).toBe(0);
  });

  it("reports a conflicting pull as conflicts rather than failing", async () => {
    await write("a.ts", "upstream\n");
    await commitAll("upstream");
    await sh(["push", "-q", bare, "main"]);
    await write("a.ts", "local\n", clone);
    await commitAll("local", clone);
    const result = await git.pull(CLONE, null, AUTHOR);
    expect(result.conflicts).toBe(true);
    const status = await git.status(CLONE);
    expect(status.mergeInProgress).toBe(true);
    expect(status.files[0]).toMatchObject({ path: "a.ts", conflicted: true });
  });

  it("checks out a remote branch as a tracking local one", async () => {
    await sh(["switch", "-q", "-c", "remote-only"]);
    await write("r.ts", "r\n");
    await commitAll("remote branch");
    await sh(["push", "-q", bare, "remote-only"]);
    await git.fetch(CLONE, null);
    const changed = await git.checkout(CLONE, "origin/remote-only", true);
    expect(changed).toEqual([{ path: "r.ts", change: "added" }]);
    expect((await git.status(CLONE))).toMatchObject({ branch: "remote-only", upstream: "origin/remote-only" });
  });
});

describe("connectRemote", () => {
  let bare: string;

  beforeEach(async () => {
    // A repository started here, with its own history, about to be pointed
    // at a remote that was started elsewhere.
    await write("local.ts", "local\n");
    await commitAll("started here");
    bare = join(root, "origin.git");
    await runGit(["init", "-q", "--bare", "-b", "main", bare], root, 20_000);
  });

  async function seedRemote(files: Record<string, string>, branch = "main") {
    const seed = join(root, "seed");
    await runGit(["clone", "-q", bare, seed], root, 20_000);
    await sh(["switch", "-q", "-C", branch], seed);
    for (const [path, content] of Object.entries(files)) await write(path, content, seed);
    await commitAll("started there", seed);
    await sh(["push", "-q", "origin", `HEAD:${branch}`], seed);
    await sh(["symbolic-ref", "HEAD", `refs/heads/${branch}`], bare);
    await rm(seed, { recursive: true, force: true });
  }

  it("adds origin and leaves an empty remote to the push", async () => {
    const result = await git.connectRemote(PROJECT, `file://${bare}`, null, AUTHOR);
    expect(result).toEqual({ mergedFrom: null, conflicts: false, changed: [] });
    expect(await git.remoteUrl(PROJECT)).toBe(`file://${bare}`);
    expect(await git.status(PROJECT)).toMatchObject({ hasRemote: true, upstream: null, branch: "main" });
    const pushed = await git.push(PROJECT, null);
    expect(pushed.branch).toBe("main");
    expect((await git.status(PROJECT)).upstream).toBe("origin/main");
  });

  it("merges the remote's same-named branch and tracks it", async () => {
    await seedRemote({ "README.md": "hello\n" });
    const result = await git.connectRemote(PROJECT, `file://${bare}`, null, AUTHOR);
    expect(result.mergedFrom).toBe("origin/main");
    expect(result.conflicts).toBe(false);
    expect(result.changed).toEqual([{ path: "README.md", change: "added" }]);
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("hello\n");
    expect(await git.status(PROJECT)).toMatchObject({ upstream: "origin/main", ahead: 2, behind: 0, mergeInProgress: false });
  });

  it("merges the remote's default branch when ours is not there", async () => {
    await seedRemote({ "README.md": "hello\n" }, "master");
    const result = await git.connectRemote(PROJECT, `file://${bare}`, null, AUTHOR);
    expect(result.mergedFrom).toBe("origin/master");
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("hello\n");
    // Not tracked: a push publishes `main` beside `master`.
    expect((await git.status(PROJECT)).upstream).toBeNull();
  });

  it("leaves a conflicting merge for the resolver", async () => {
    await seedRemote({ "local.ts": "theirs\n" });
    const result = await git.connectRemote(PROJECT, `file://${bare}`, null, AUTHOR);
    expect(result.mergedFrom).toBe("origin/main");
    expect(result.conflicts).toBe(true);
    const status = await git.status(PROJECT);
    expect(status.mergeInProgress).toBe(true);
    expect(status.files[0]).toMatchObject({ path: "local.ts", conflicted: true });
    await git.resolve(PROJECT, "local.ts", "ours");
    await git.commit(PROJECT, { summary: "merge" }, AUTHOR);
    expect((await git.status(PROJECT)).mergeInProgress).toBe(false);
  });

  it("takes the remote away again when it cannot be fetched", async () => {
    await expect(git.connectRemote(PROJECT, `file://${root}/nowhere.git`, null, AUTHOR)).rejects.toThrow(GitError);
    expect(await git.remoteUrl(PROJECT)).toBeNull();
    expect((await git.status(PROJECT)).hasRemote).toBe(false);
  });

  it("refuses a second origin and a transport git would run", async () => {
    await expect(git.connectRemote(PROJECT, "ext::sh -c whoami", null, AUTHOR)).rejects.toThrow(/transport/);
    await git.connectRemote(PROJECT, `file://${bare}`, null, AUTHOR);
    await expect(git.connectRemote(PROJECT, `file://${bare}`, null, AUTHOR)).rejects.toThrow(/already exists/);
  });
});

describe("setRemoteUrl and removeRemote", () => {
  beforeEach(async () => {
    await write("a.txt", "a\n");
    await commitAll("first");
  });

  it("moves origin without touching the history", async () => {
    await sh(["remote", "add", "origin", "https://example.com/old.git"]);
    const head = (await sh(["rev-parse", "HEAD"])).trim();
    await git.setRemoteUrl(PROJECT, "https://example.com/new.git");
    expect(await git.remoteUrl(PROJECT)).toBe("https://example.com/new.git");
    expect((await sh(["rev-parse", "HEAD"])).trim()).toBe(head);
  });

  it("refuses a transport it does not allow", async () => {
    await sh(["remote", "add", "origin", "https://example.com/old.git"]);
    await expect(git.setRemoteUrl(PROJECT, "ext::sh -c whoami")).rejects.toThrow(/transport/);
    expect(await git.remoteUrl(PROJECT)).toBe("https://example.com/old.git");
  });

  it("forgets origin and keeps the commits", async () => {
    await sh(["remote", "add", "origin", "https://example.com/old.git"]);
    await git.removeRemote(PROJECT);
    expect(await git.remoteUrl(PROJECT)).toBeNull();
    expect((await git.status(PROJECT)).hasRemote).toBe(false);
    expect((await sh(["log", "--format=%s"])).trim()).toBe("first");
  });

  it("cannot move or remove a remote that is not there", async () => {
    await expect(git.setRemoteUrl(PROJECT, "https://example.com/new.git")).rejects.toThrow(GitError);
    await expect(git.removeRemote(PROJECT)).rejects.toThrow(GitError);
  });
});
