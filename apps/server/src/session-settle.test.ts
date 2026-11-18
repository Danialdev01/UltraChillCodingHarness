import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionFilesBeyondAgent, sessionProjectHasWork } from "./session-settle.js";
import { GitService } from "./git.js";
import { runGit } from "./git-exec.js";
import { projectRoot } from "./trees.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-settle-"));
});

describe("automatic cleanup of a session workspace project", () => {
  let initialHead: string;
  let git: GitService;
  const sh = (args: string[]) => runGit([
    "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args,
  ], projectRoot(root, PROJECT), 20_000);

  beforeEach(async () => {
    const dir = projectRoot(root, PROJECT);
    await mkdir(dir, { recursive: true });
    await sh(["init", "-q", "-b", "main"]);
    await writeFile(join(dir, "README.md"), "# New session\n");
    await sh(["add", "README.md"]);
    await sh(["commit", "-q", "--no-verify", "-m", "Initialize"]);
    initialHead = (await sh(["rev-parse", "HEAD"])).trim();
    git = new GitService(root);
  });

  it("allows an untouched initialized session to be removed", async () => {
    expect(await sessionProjectHasWork(root, PROJECT, initialHead, git)).toBe(false);
  });

  it("protects a changed seed README even when it still looks like a seed", async () => {
    await writeFile(join(projectRoot(root, PROJECT), "README.md"), "# My work\n");
    expect(await sessionProjectHasWork(root, PROJECT, initialHead, git)).toBe(true);
  });

  it("protects committed work with a clean checkout", async () => {
    await writeFile(join(projectRoot(root, PROJECT), "README.md"), "# My work\n");
    await sh(["add", "README.md"]);
    await sh(["commit", "-q", "--no-verify", "-m", "Work"]);
    expect((await git.status(PROJECT)).files).toEqual([]);
    expect(await sessionProjectHasWork(root, PROJECT, initialHead, git)).toBe(true);
  });

  it("protects files ignored by git", async () => {
    await writeFile(join(projectRoot(root, PROJECT), ".git", "info", "exclude"), "secret.txt\n");
    await writeFile(join(projectRoot(root, PROJECT), "secret.txt"), "work");
    expect((await git.status(PROJECT)).files).toEqual([]);
    expect(await sessionProjectHasWork(root, PROJECT, initialHead, git)).toBe(true);
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sessionFilesBeyondAgent", () => {
  it("counts nothing for a missing folder, or one with only .agent/ and .git/", async () => {
    expect(await sessionFilesBeyondAgent(root, PROJECT)).toEqual({ count: 0, names: [] });
    const dir = projectRoot(root, PROJECT);
    await mkdir(join(dir, ".agent", "diagrams"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# New session\n");
    expect(await sessionFilesBeyondAgent(root, PROJECT)).toEqual({ count: 0, names: [] });
  });

  it("lists anything else at the top level", async () => {
    const dir = projectRoot(root, PROJECT);
    await mkdir(join(dir, ".agent"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# New session\n\nNotes the agent wrote.\n");
    await writeFile(join(dir, ".env"), "X=1");
    expect(await sessionFilesBeyondAgent(root, PROJECT, 2)).toEqual({ count: 3, names: [".env", "README.md"] });
  });
});
