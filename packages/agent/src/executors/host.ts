import { spawn } from "node:child_process";
import { mkdir, open, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { normalizeWorkspacePath } from "@ucch/protocol";
import {
  ExecInterruptedError,
  type ExecOptions,
  type ExecResult,
  type Executor,
} from "../executor.js";
import { assertRealpathInside, isGitInternalPath } from "./confine.js";

/** Captured per stream before the remainder is drained and dropped. */
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Read by `readFile` when the caller names no limit of its own. */
const DEFAULT_MAX_READ_BYTES = 1024 * 1024;

/** How long a process gets to exit on SIGTERM before SIGKILL follows. */
const KILL_GRACE_MS = 2_000;

/**
 * Runs tools on the host, in the project's workspace directory.
 *
 * This is remote code execution by whichever model the composer selected,
 * and that was chosen knowingly -- see `idea.md` §2.1. The mitigations here
 * are real and none of them changes that fact: the working directory is
 * pinned, every path goes through `resolve()`, commands are argv arrays,
 * the environment is rebuilt rather than inherited, and everything has a
 * timeout and an output cap. The durable fix is the container executor.
 */
export class HostExecutor implements Executor {
  readonly #root: string;

  constructor(root: string) {
    // Normalised once so every later comparison is against a canonical
    // absolute path with no trailing separator.
    this.#root = resolvePath(root);
  }

  root(): string {
    return this.#root;
  }

  /**
   * Turns a model-supplied path into an absolute one inside the workspace.
   *
   * Absolute input is refused rather than reinterpreted. `normalizeWorkspacePath`
   * strips a leading slash -- which is right for a `file.write` command, where
   * `/routes/web.php` plainly means the workspace's own `routes/web.php` --
   * but a model writing `/etc/hosts` means the host's, and quietly creating
   * `<workspace>/etc/hosts` instead would be a confusing lie. An error the
   * model can read and correct is better than a file in a surprising place.
   *
   * Empty input throws too: `""` and `"."` mean the workspace root to a
   * caller like `list_dir`, and that is the caller's decision to make, not a
   * meaning this can guess.
   *
   * The check here is lexical; the file methods add `#confined`, which
   * follows symlinks. That does not contain `bash`, but it does mean that
   * with the shell off, the file tools cannot be steered out of the tree by
   * a link a cloned repository shipped.
   *
   * `.git` is refused outright: its config and hooks are commands the
   * server runs on the next `git status`.
   */
  resolve(path: string): string {
    if (isAbsolute(path)) {
      throw new Error(`path must be relative to the workspace root: ${path}`);
    }
    const normalized = normalizeWorkspacePath(path);
    if (normalized === null) {
      throw new Error(`path escapes the workspace: ${JSON.stringify(path)}`);
    }
    if (isGitInternalPath(normalized)) {
      throw new Error(`the repository's .git directory is off limits: ${path}`);
    }

    const absolute = resolvePath(this.#root, normalized);
    // Belt and braces: `normalizeWorkspacePath` has already refused traversal,
    // and this refuses anything that got past it regardless of how.
    if (absolute !== this.#root && !absolute.startsWith(this.#root + sep)) {
      throw new Error(`path escapes the workspace: ${path}`);
    }
    return absolute;
  }

  /** `resolve`, then refused if a symlink along the way leads out of the tree. */
  async #confined(path: string): Promise<string> {
    const absolute = this.resolve(path);
    await assertRealpathInside(
      this.#root,
      absolute,
      () => new Error(`path escapes the workspace through a symlink: ${path}`),
    );
    return absolute;
  }

  async exec(argv: string[], options: ExecOptions): Promise<ExecResult> {
    const [command, ...args] = argv;
    if (!command) throw new Error("exec requires a command");

    const cwd = options.cwd ? this.resolve(options.cwd) : this.#root;
    const cap = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    return new Promise<ExecResult>((settle, fail) => {
      const child = spawn(command, args, {
        cwd,
        env: safeEnv(),
        // stdin is closed rather than inherited: a command that reads it gets
        // EOF immediately instead of blocking until the timeout.
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so killing it kills what it spawned. A
        // `bash` script that backgrounded a server would otherwise outlive
        // the tool call that started it.
        detached: true,
      });

      const stdout = new Capture(cap);
      const stderr = new Capture(cap);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      let interrupted: "timeout" | "aborted" | null = null;
      let killTimer: NodeJS.Timeout | undefined;

      const kill = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          // Negative pid addresses the group, which is why `detached` is set.
          process.kill(-child.pid, signal);
        } catch {
          // Already gone, or never grouped. Try the child on its own.
          try {
            child.kill(signal);
          } catch {
            /* it is dead either way */
          }
        }
      };

      const interrupt = (reason: "timeout" | "aborted") => {
        if (interrupted) return;
        interrupted = reason;
        kill("SIGTERM");
        // A process that ignores SIGTERM does not get to hold the turn open.
        killTimer = setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS);
        killTimer.unref();
      };

      const timer = setTimeout(() => interrupt("timeout"), options.timeoutMs);
      const onAbort = () => interrupt("aborted");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();

      const cleanup = () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
      };

      child.on("error", (error) => {
        cleanup();
        // Most often a missing binary: `rg` absent from the image is the one
        // that will actually happen, and it deserves to say so.
        fail(new Error(`could not run ${command}: ${error.message}`));
      });

      child.on("close", (code) => {
        cleanup();
        const result: ExecResult = {
          stdout: stdout.text(),
          stderr: stderr.text(),
          // A process killed by a signal reports a null code.
          exitCode: code ?? -1,
          truncated: stdout.truncated || stderr.truncated,
        };

        if (interrupted === "timeout") {
          fail(
            new ExecInterruptedError(
              "timeout",
              result,
              `${command} timed out after ${options.timeoutMs}ms`,
            ),
          );
          return;
        }
        if (interrupted === "aborted") {
          fail(new ExecInterruptedError("aborted", result, `${command} was cancelled`));
          return;
        }
        settle(result);
      });
    });
  }

  async readFile(path: string, options: { maxBytes?: number } = {}): Promise<string> {
    const absolute = await this.#confined(path);
    const max = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;

    // Opened and read by the byte rather than slurped: a tool asking for the
    // first 200 lines of a file should not put a gigabyte in memory first.
    const handle = await open(absolute, "r");
    try {
      const buffer = Buffer.allocUnsafe(max);
      const { bytesRead } = await handle.read(buffer, 0, max, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    const absolute = await this.#confined(path);
    // A model writing `src/routes/health.ts` into a project that has no
    // `routes` directory means to create one.
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }

  /**
   * Deletes a file, and only a file.
   *
   * A directory is refused rather than removed recursively: the difference
   * between deleting `src/old.ts` and deleting `src` is one character in a
   * model's argument, and only one of those is recoverable from the
   * checkpoint the turn took at its start.
   */
  async removeFile(path: string): Promise<boolean> {
    const absolute = await this.#confined(path);

    const info = await stat(absolute).catch(() => null);
    if (info === null) return false;
    if (info.isDirectory()) {
      throw new Error(`${path} is a directory; only files can be deleted`);
    }

    await rm(absolute, { force: true });
    return true;
  }
}

/**
 * The environment a tool process gets.
 *
 * Rebuilt from nothing rather than inherited: the server's own environment
 * holds `DATABASE_URL`, `SECRET_KEY` and the GitHub client secret, and
 * `bash` would otherwise only have to run `env` to read all three.
 */
function safeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    // Stops interactive tools reaching for cursor addressing and colour.
    TERM: "dumb",
  };
}

/**
 * Accumulates output up to a cap.
 *
 * Past the cap the chunks are still consumed and then dropped -- a reader
 * that simply stops reading fills the pipe and blocks the child, turning a
 * chatty command into a timeout.
 */
class Capture {
  #chunks: Buffer[] = [];
  #size = 0;
  truncated = false;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.#size >= this.cap) {
      this.truncated = true;
      return;
    }
    const room = this.cap - this.#size;
    if (chunk.length > room) {
      this.#chunks.push(chunk.subarray(0, room));
      this.#size = this.cap;
      this.truncated = true;
      return;
    }
    this.#chunks.push(chunk);
    this.#size += chunk.length;
  }

  /** Decoded once, at the end: a chunk boundary can split a UTF-8 sequence. */
  text(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}
