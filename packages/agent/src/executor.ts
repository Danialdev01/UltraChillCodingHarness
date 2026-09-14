/**
 * The execution boundary.
 *
 * `plan.md` §5.3 states the invariant: every tool executes inside the
 * project container, and the server never touches workspace files directly.
 * There is no Docker driver yet, so the invariant is expressed as this
 * interface and satisfied later -- `DockerExecutor` replaces `HostExecutor`
 * at Phase 2 and no tool code changes.
 *
 * Two properties do the work. Commands are `argv` arrays, never shell
 * strings, so nothing is word-split or interpolated and a filename with a
 * space or a semicolon cannot become a second command. And `resolve()` is the
 * only way to turn a model-supplied path into a real one.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Output passed the executor's byte cap; what is here is the head of it. */
  truncated: boolean;
}

export interface ExecOptions {
  /** Defaults to the workspace root. Resolved through `resolve()` first. */
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Bytes captured per stream before the rest is read and discarded. */
  maxOutputBytes?: number;
}

export interface Executor {
  /**
   * Runs one command. Rejects rather than returning on timeout or abort --
   * see `ExecInterruptedError`, which carries whatever was captured first.
   */
  exec(argv: string[], options: ExecOptions): Promise<ExecResult>;
  readFile(path: string, options?: { maxBytes?: number }): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  /**
   * Removes one file. Resolves false when there was nothing there, so a
   * caller can tell "deleted" from "already gone" without a prior stat.
   *
   * Part of the boundary rather than left to `bash -c rm`: deleting a file
   * is an ordinary edit, and a deployment that has not handed the model a
   * shell must still be able to do it.
   */
  removeFile(path: string): Promise<boolean>;
  /** Throws for any path that is not inside `root()`. */
  resolve(path: string): string;
  root(): string;
}

/**
 * A command that did not finish on its own: it ran past its timeout, or the
 * turn was cancelled underneath it.
 *
 * It carries the output captured up to that point. A test suite that hangs at
 * 119 seconds is far more useful to the model with its output than without,
 * and this keeps `ExecResult` to the four fields the design names rather than
 * growing a `timedOut` flag that every caller would have to remember to read.
 */
export class ExecInterruptedError extends Error {
  constructor(
    readonly reason: "timeout" | "aborted",
    readonly result: ExecResult,
    message: string,
  ) {
    super(message);
    this.name = "ExecInterruptedError";
  }
}
