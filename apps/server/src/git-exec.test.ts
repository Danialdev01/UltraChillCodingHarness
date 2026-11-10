import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitSubcommand, runGit } from "./git-exec.js";

describe("gitSubcommand", () => {
  it("finds the subcommand after the options", () => {
    expect(gitSubcommand(["status", "--porcelain=v2"])).toBe("status");
    expect(gitSubcommand(["--no-pager", "log", "-n", "5"])).toBe("log");
  });

  it("never mistakes a -c or -C value for it", () => {
    // The commit identity is a person's name: it must not become a label.
    expect(gitSubcommand(["-c", "user.name=Ada Lovelace", "-c", "user.email=ada@example.com", "commit", "-m", "x"])).toBe(
      "commit",
    );
    expect(gitSubcommand(["-C", "/data/workspaces/p", "rev-parse", "HEAD"])).toBe("rev-parse");
  });

  it("names a command line with no subcommand as other", () => {
    expect(gitSubcommand([])).toBe("other");
    expect(gitSubcommand(["-c", "x=y"])).toBe("other");
  });
});

describe("runGit's environment", () => {
  it("does not inherit GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE from the server", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ucch-git-env-")));
    const saved = { dir: process.env.GIT_DIR, tree: process.env.GIT_WORK_TREE, index: process.env.GIT_INDEX_FILE };
    try {
      await runGit(["init", "-q", "-b", "main", join(root, "repo")], root, 20_000);
      process.env.GIT_DIR = join(root, "elsewhere", ".git");
      process.env.GIT_WORK_TREE = join(root, "elsewhere");
      process.env.GIT_INDEX_FILE = join(root, "elsewhere", "index");
      const env = await runGit(["var", "-l"], join(root, "repo"), 20_000);
      expect(env).not.toMatch(/GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE/);
      expect((await runGit(["rev-parse", "--absolute-git-dir"], join(root, "repo"), 20_000)).trim()).toBe(
        join(root, "repo", ".git"),
      );
    } finally {
      for (const [key, value] of [
        ["GIT_DIR", saved.dir],
        ["GIT_WORK_TREE", saved.tree],
        ["GIT_INDEX_FILE", saved.index],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
