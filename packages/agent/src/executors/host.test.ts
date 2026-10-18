import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExecInterruptedError } from "../executor.js";
import { HostExecutor } from "./host.js";

let root: string;
let executor: HostExecutor;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-executor-"));
  executor = new HostExecutor(root);
  await writeFile(join(root, "readme.md"), "hello\nworld\n", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolve", () => {
  it("resolves an ordinary path inside the workspace", () => {
    expect(executor.resolve("src/index.ts")).toBe(join(root, "src/index.ts"));
    expect(executor.resolve("./a//b/./c")).toBe(join(root, "a/b/c"));
    // Traversal that cancels out stays inside, so it is allowed.
    expect(executor.resolve("a/b/../c")).toBe(join(root, "a/c"));
  });

  it("rejects traversal above the root", () => {
    expect(() => executor.resolve("../etc/passwd")).toThrow(/escapes the workspace/);
    expect(() => executor.resolve("a/../../b")).toThrow(/escapes the workspace/);
    expect(() => executor.resolve("a/b/../../../c")).toThrow(/escapes the workspace/);
  });

  // Refused rather than reinterpreted as workspace-relative: a model writing
  // /etc/hosts means the host's, and creating <workspace>/etc/hosts instead
  // would be a lie it could not see.
  it("rejects absolute paths", () => {
    expect(() => executor.resolve("/etc/passwd")).toThrow(/must be relative/);
    expect(() => executor.resolve("/")).toThrow(/must be relative/);
  });

  it("rejects null bytes", () => {
    expect(() => executor.resolve("a\0b")).toThrow(/escapes the workspace/);
  });

  // "" and "." mean the root to a caller like list_dir, and that is the
  // caller's decision rather than one this can guess.
  it("rejects paths that normalise to nothing", () => {
    expect(() => executor.resolve("")).toThrow();
    expect(() => executor.resolve(".")).toThrow();
  });

  it("does not treat a sibling directory with the same prefix as inside", () => {
    // <root>-evil starts with <root> as a string but is not under it.
    const sneaky = new HostExecutor(root);
    expect(() => sneaky.resolve("../" + root.split("/").pop() + "-evil/x")).toThrow(
      /escapes the workspace/,
    );
  });
});

describe("files", () => {
  it("reads and writes inside the workspace", async () => {
    await executor.writeFile("nested/deep/note.txt", "written");
    expect(await executor.readFile("nested/deep/note.txt")).toBe("written");
    // The parent directories are created rather than erroring.
    expect(await readFile(join(root, "nested/deep/note.txt"), "utf8")).toBe("written");
  });

  it("clamps a read to the requested byte count", async () => {
    expect(await executor.readFile("readme.md", { maxBytes: 5 })).toBe("hello");
  });

  it("refuses the repository's .git directory", async () => {
    await expect(executor.writeFile(".git/config", "x")).rejects.toThrow(/\.git/);
    await expect(executor.readFile("sub/.git/hooks/pre-commit")).rejects.toThrow(/\.git/);
  });

  it("refuses to follow a symlink out of the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ucch-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret");
      await symlink(outside, join(root, "linked"));
      await symlink(join(outside, "secret.txt"), join(root, "secret-link.txt"));

      await expect(executor.readFile("secret-link.txt")).rejects.toThrow(/symlink/);
      await expect(executor.writeFile("linked/new.txt", "x")).rejects.toThrow(/symlink/);
      await expect(readFile(join(outside, "new.txt"), "utf8")).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a read or a write outside the root", async () => {
    await expect(executor.readFile("../../etc/passwd")).rejects.toThrow(/escapes the workspace/);
    await expect(executor.writeFile("/tmp/pwned", "x")).rejects.toThrow(/must be relative/);
  });
});

describe("exec", () => {
  it("runs a command with the workspace as its working directory", async () => {
    const result = await executor.exec(["pwd"], { timeoutMs: 5_000 });
    expect(result.stdout.trim()).toBe(root);
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("reports a non-zero exit and stderr rather than throwing", async () => {
    const result = await executor.exec(["bash", "-c", "echo oops >&2; exit 3"], {
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe("oops");
  });

  // argv arrays, never a shell string: the semicolon is part of the argument,
  // not a second command.
  it("does not word-split or interpret its arguments", async () => {
    const result = await executor.exec(["echo", "a b; touch pwned"], { timeoutMs: 5_000 });
    expect(result.stdout.trim()).toBe("a b; touch pwned");
    await expect(readFile(join(root, "pwned"), "utf8")).rejects.toThrow();
  });

  it("resolves a relative cwd against the root and refuses one outside it", async () => {
    const inside = await executor.exec(["pwd"], { cwd: "nested", timeoutMs: 5_000 });
    expect(inside.stdout.trim()).toBe(join(root, "nested"));
    await expect(executor.exec(["pwd"], { cwd: "../", timeoutMs: 5_000 })).rejects.toThrow(
      /escapes the workspace/,
    );
  });

  // The server's own environment holds DATABASE_URL and SECRET_KEY.
  it("does not hand the server's environment to the child", async () => {
    process.env.UCCH_TEST_SECRET = "leaked";
    try {
      const result = await executor.exec(
        ["bash", "-c", "echo ${UCCH_TEST_SECRET:-absent}-$TERM"],
        { timeoutMs: 5_000 },
      );
      expect(result.stdout.trim()).toBe("absent-dumb");
    } finally {
      delete process.env.UCCH_TEST_SECRET;
    }
  });

  it("caps captured output and says so", async () => {
    const result = await executor.exec(["bash", "-c", "head -c 5000 /dev/zero | tr '\\0' 'x'"], {
      timeoutMs: 5_000,
      maxOutputBytes: 100,
    });
    expect(result.stdout).toHaveLength(100);
    expect(result.truncated).toBe(true);
    // The process still finished: past the cap the output is drained and
    // dropped, rather than left to fill the pipe and block the child.
    expect(result.exitCode).toBe(0);
  });

  it("times out, and keeps what the command managed to print", async () => {
    const error = await executor
      .exec(["bash", "-c", "echo started; sleep 30"], { timeoutMs: 300 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExecInterruptedError);
    const interrupted = error as ExecInterruptedError;
    expect(interrupted.reason).toBe("timeout");
    expect(interrupted.result.stdout.trim()).toBe("started");
  });

  it("stops when the turn is cancelled", async () => {
    const controller = new AbortController();
    const running = executor.exec(["sleep", "30"], {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const error = await running.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExecInterruptedError);
    expect((error as ExecInterruptedError).reason).toBe("aborted");
  });

  it("stops immediately when the signal is already aborted", async () => {
    await expect(
      executor.exec(["sleep", "30"], { timeoutMs: 30_000, signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(ExecInterruptedError);
  });

  // `rg` missing from the image is the one that will actually happen.
  it("names the binary it could not run", async () => {
    await expect(
      executor.exec(["ucch-definitely-not-installed"], { timeoutMs: 5_000 }),
    ).rejects.toThrow(/could not run ucch-definitely-not-installed/);
  });

  it("kills the whole process group, not just the shell", async () => {
    const marker = join(root, "survivor.txt");
    // The backgrounded child outlives its parent shell unless the group goes.
    await executor
      .exec(["bash", "-c", `(sleep 1; echo alive > ${marker}) & sleep 30`], { timeoutMs: 200 })
      .catch(() => {});

    await new Promise((r) => setTimeout(r, 1_500));
    await expect(readFile(marker, "utf8")).rejects.toThrow();
  });
});
