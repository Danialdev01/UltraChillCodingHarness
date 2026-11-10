import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "./git-exec.js";
import { ProjectGit, SettleRefusedError, type SettleInput } from "./project-git.js";
import { projectRoot, sessionTree } from "./trees.js";

// Real git in temp directories throughout: nothing here is mocked.

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTHOR = { name: "Test", email: "test@example.com" };
const IDENTITY = ["-c", `user.name=${AUTHOR.name}`, "-c", `user.email=${AUTHOR.email}`];

let root: string;
let git: ProjectGit;

const sh = (cwd: string, ...argv: string[]) => runGit([...IDENTITY, ...argv], cwd, 20_000);
const out = async (cwd: string, ...argv: string[]) => (await sh(cwd, ...argv)).trim();
const exists = (path: string) => stat(path).then(() => true, () => false);

/** A bare origin whose default branch is `branch`, with one commit holding `files`. */
async function makeOrigin(name: string, branch: string, files: Record<string, string> = { "README.md": `${name}\n` }) {
  const origin = join(root, "origins", `${name}.git`);
  const seed = join(root, "seeds", name);
  await mkdir(seed, { recursive: true });
  await sh(root, "init", "-q", "--bare", "-b", branch, origin);
  await sh(seed, "init", "-q", "-b", branch);
  for (const [path, body] of Object.entries(files)) await writeFile(join(seed, path), body);
  await sh(seed, "add", "-A");
  await sh(seed, "commit", "-q", "--no-verify", "-m", `${name}: initial`);
  await sh(seed, "remote", "add", "origin", origin);
  await sh(seed, "push", "-q", "origin", branch);
  return origin;
}

/** Clones an origin as a project's checkout, the way `ProjectCloner` lays it out. */
async function cloneProject(projectId: string, origin: string) {
  const repo = projectRoot(root, projectId);
  await sh(root, "clone", "-q", origin, repo);
  return repo;
}

async function edit(dir: string, path: string, body: string, message?: string) {
  await writeFile(join(dir, path), body);
  if (message) {
    await sh(dir, "add", "-A");
    await sh(dir, "commit", "-q", "--no-verify", "-m", message);
  }
}

function settleInput(projectId: string, hash: string, baseBranch: string, overrides: Partial<SettleInput> = {}): SettleInput {
  return {
    projectId,
    hash,
    tree: sessionTree(root, projectId, hash),
    branch: `ucch/${hash}`,
    baseBranch,
    title: `Session ${hash}`,
    author: AUTHOR,
    token: null,
    deleteBranch: true,
    autoPush: false,
    ...overrides,
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ucch-project-git-")));
  git = new ProjectGit(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("per-project isolation", () => {
  it("gives each project's sessions worktrees of that project's own repository", async () => {
    const originA = await makeOrigin("alpha", "main");
    const originB = await makeOrigin("beta", "main");
    const repoA = await cloneProject(A, originA);
    const repoB = await cloneProject(B, originB);

    const treeA = await git.addWorktree(A, "sessiona0001", "ucch/sessiona0001", "main");
    const treeB = await git.addWorktree(B, "sessionb0001", "ucch/sessionb0001", "main");

    const common = async (tree: string) => resolve(tree, await out(tree, "rev-parse", "--git-common-dir"));
    expect(await common(treeA)).toBe(join(repoA, ".git"));
    expect(await common(treeB)).toBe(join(repoB, ".git"));
    expect(await out(treeA, "remote", "get-url", "origin")).toBe(originA);
    expect(await out(treeB, "remote", "get-url", "origin")).toBe(originB);
    // Neither repository knows the other's session.
    expect(await out(repoA, "branch", "--list", "--format=%(refname:short)", "ucch/*")).toBe("ucch/sessiona0001");
    expect(await out(repoB, "branch", "--list", "--format=%(refname:short)", "ucch/*")).toBe("ucch/sessionb0001");
    expect(await out(repoA, "worktree", "list")).not.toContain("sessionb0001");
  });
});

describe("a project whose default branch is production", () => {
  it("forks sessions from production and settles them into it, with no main anywhere", async () => {
    const origin = await makeOrigin("prod", "production");
    const repo = await cloneProject(A, origin);

    const base = await git.detectBaseBranch(A);
    expect(base).toBe("production");

    const tree = await git.addWorktree(A, "prodsess0001", "ucch/prodsess0001", base!);
    expect(await out(tree, "rev-parse", "HEAD")).toBe(await out(repo, "rev-parse", "production"));
    await edit(tree, "feature.txt", "feature\n", "add feature");

    const result = await git.settle(settleInput(A, "prodsess0001", base!));
    expect(result).toMatchObject({ state: "settled", baseBranch: "production" });
    expect(await out(repo, "show", "production:feature.txt")).toBe("feature");
    expect((await out(repo, "log", "-1", "--format=%P", "production")).split(" ")).toHaveLength(2);
    expect(await out(repo, "branch", "--list", "main")).toBe("");
    expect(await exists(tree)).toBe(false);
  });
});

describe("changing the base branch", () => {
  it("forks a new session from the new base and settles into it; an older session keeps where it came from", async () => {
    const repo = await cloneProject(A, await makeOrigin("rel", "main"));
    const older = await git.addWorktree(A, "oldsession01", "ucch/oldsession01", "main");
    const mainSha = await out(repo, "rev-parse", "main");

    await sh(repo, "branch", "release");
    await edit(repo, "release.txt", "rel\n");
    await sh(repo, "checkout", "-q", "release");
    await sh(repo, "add", "-A");
    await sh(repo, "commit", "-q", "--no-verify", "-m", "release only");
    await sh(repo, "checkout", "-q", "main");
    expect(await git.branchExists(A, "release")).toBe("local");

    const newer = await git.addWorktree(A, "newsession01", "ucch/newsession01", "release");
    expect(await out(newer, "rev-parse", "HEAD")).toBe(await out(repo, "rev-parse", "release"));
    expect(await out(older, "rev-parse", "HEAD")).toBe(mainSha);

    // Settling either now goes to release, which is not checked out: the
    // merge happens in a temporary worktree that is gone afterwards.
    await edit(older, "old.txt", "old\n");
    const result = await git.settle(settleInput(A, "oldsession01", "release"));
    expect(result).toMatchObject({ state: "settled", baseBranch: "release" });
    expect(await out(repo, "show", "release:old.txt")).toBe("old");
    expect(await out(repo, "rev-parse", "main")).toBe(mainSha);
    expect(await out(repo, "worktree", "list")).not.toContain(".settle-");
  });

  it("knows a branch that exists only on origin, and refuses one that does not exist", async () => {
    const origin = await makeOrigin("remote-only", "main");
    const seed = join(root, "seeds", "remote-only");
    await sh(seed, "push", "-q", "origin", "main:staging");
    await cloneProject(A, origin);
    expect(await git.branchExists(A, "staging")).toBe("remote");
    expect(await git.branchExists(A, "nope")).toBeNull();
    expect(await git.branchExists(A, "--upload-pack=evil")).toBeNull();

    const tree = await git.addWorktree(A, "stagsess0001", "ucch/stagsess0001", "staging");
    await edit(tree, "s.txt", "s\n");
    expect(await git.settle(settleInput(A, "stagsess0001", "staging"))).toMatchObject({ state: "settled" });
  });
});

describe("settle refusals", () => {
  it("refuses while the base's checkout has uncommitted changes, and changes nothing", async () => {
    const repo = await cloneProject(A, await makeOrigin("dirty", "main"));
    const tree = await git.addWorktree(A, "dirtysess001", "ucch/dirtysess001", "main");
    await edit(tree, "x.txt", "x\n", "x");
    await edit(repo, "README.md", "edited in the checkout\n");
    const before = await out(repo, "rev-parse", "main");

    await expect(git.settle(settleInput(A, "dirtysess001", "main"))).rejects.toBeInstanceOf(SettleRefusedError);
    expect(await out(repo, "rev-parse", "main")).toBe(before);
    expect(await exists(tree)).toBe(true);
  });

  it("refuses when the base has diverged from origin's", async () => {
    const origin = await makeOrigin("diverged", "main");
    const repo = await cloneProject(A, origin);
    const seed = join(root, "seeds", "diverged");
    await edit(seed, "remote.txt", "r\n", "remote moved");
    await sh(seed, "push", "-q", "origin", "main");
    await edit(repo, "local.txt", "l\n", "local moved");
    const tree = await git.addWorktree(A, "divsession01", "ucch/divsession01", "main");
    await edit(tree, "s.txt", "s\n", "s");

    await expect(git.settle(settleInput(A, "divsession01", "main"))).rejects.toThrow(/diverged/);
    expect(await out(repo, "log", "-1", "--format=%s", "main")).toBe("local moved");
  });
});

describe("concurrency", () => {
  it("settles two sessions of one project at once, one after the other under the project's lock", async () => {
    const repo = await cloneProject(A, await makeOrigin("conc", "main"));
    const one = await git.addWorktree(A, "concurrent01", "ucch/concurrent01", "main");
    const two = await git.addWorktree(A, "concurrent02", "ucch/concurrent02", "main");
    await edit(one, "one.txt", "1\n");
    await edit(two, "two.txt", "2\n");

    const results = await Promise.all([
      git.settle(settleInput(A, "concurrent01", "main")),
      git.settle(settleInput(A, "concurrent02", "main")),
    ]);
    expect(results.map((r) => r.state)).toEqual(["settled", "settled"]);
    expect(await out(repo, "show", "main:one.txt")).toBe("1");
    expect(await out(repo, "show", "main:two.txt")).toBe("2");
    expect((await out(repo, "rev-list", "--merges", "--count", "main"))).toBe("2");
    expect(await out(repo, "worktree", "list")).not.toContain("concurrent");
  });

  it("creates worktrees for several sessions at once without tripping over .git's locks", async () => {
    const repo = await cloneProject(A, await makeOrigin("many", "main"));
    const hashes = ["manysess0001", "manysess0002", "manysess0003", "manysess0004"];
    await Promise.all(hashes.map((h) => git.addWorktree(A, h, `ucch/${h}`, "main")));
    expect((await out(repo, "branch", "--list", "ucch/*")).split("\n")).toHaveLength(4);
  });
});

describe("the server's own repository", () => {
  let cwd: string;
  let gitDir: string | undefined;

  beforeEach(() => {
    cwd = process.cwd();
    gitDir = process.env.GIT_DIR;
  });

  afterEach(() => {
    process.chdir(cwd);
    if (gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = gitDir;
  });

  it("is never touched, even from inside it with GIT_DIR pointing at it", async () => {
    // A stand-in for UCCH's own checkout: the process runs in it, and an
    // inherited GIT_DIR names it.
    const own = join(root, "ucch-itself");
    await mkdir(own, { recursive: true });
    await sh(own, "init", "-q", "-b", "main");
    await edit(own, "server.ts", "// ucch\n", "ucch: initial");
    const snapshot = async () => ({
      refs: await out(own, "for-each-ref", "--format=%(refname) %(objectname)"),
      worktrees: await out(own, "worktree", "list", "--porcelain"),
      reflog: await out(own, "reflog", "--all"),
      status: await out(own, "status", "--porcelain"),
    });
    const before = await snapshot();

    process.chdir(own);
    process.env.GIT_DIR = join(own, ".git");

    const repo = await cloneProject(A, await makeOrigin("iso", "main"));
    const tree = await git.addWorktree(A, "isosession01", "ucch/isosession01", "main");
    await edit(tree, "work.txt", "work\n");
    expect(await git.settle(settleInput(A, "isosession01", "main"))).toMatchObject({ state: "settled" });
    expect(await out(repo, "show", "main:work.txt")).toBe("work");

    delete process.env.GIT_DIR;
    expect(await snapshot()).toEqual(before);
  });
});
