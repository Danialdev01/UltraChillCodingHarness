import { ExecInterruptedError, type ExecOptions, type ExecResult, type Executor } from "@ucch/agent";
import { normalizeRemotePath, remoteParent } from "@ucch/protocol";
import type { PooledSsh } from "./ssh-hosts.js";

/** Bytes kept per stream by default, the same order as the host executor's. */
const DEFAULT_MAX_OUTPUT = 256 * 1024;

/** A word the remote shell reads as exactly itself. */
export function shellQuote(word: string): string {
  if (/^[A-Za-z0-9_\/.,:=@%+-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command line for an argv on a remote host.
 *
 * The agent's `bash` tool asks for `bash -lc <command>`. A server without
 * bash -- Alpine, BusyBox -- still has `sh`, so that one case falls back to
 * it rather than failing with "bash: not found". Anything else is quoted
 * word by word, so nothing is split or interpolated on the way.
 */
export function remoteCommandLine(argv: readonly string[], cwd: string | null): string {
  let line: string;
  if (argv.length === 3 && argv[0] === "bash" && argv[1] === "-lc") {
    const script = shellQuote(argv[2]!);
    line = `if command -v bash >/dev/null 2>&1; then exec bash -lc ${script}; else exec sh -lc ${script}; fi`;
  } else {
    line = argv.map(shellQuote).join(" ");
  }
  return cwd ? `cd ${shellQuote(cwd)} && ${line}` : line;
}

/**
 * The agent's tools, run on an SSH host instead of in a project.
 *
 * The same `Executor` the host and Docker ones are, so `bash`, `read_file`,
 * `write_file` and `edit_file` work unchanged: commands go over `exec`,
 * files over SFTP. There is no root to confine to -- whoever may use this
 * agent may also open a shell on the host as the same login -- so paths are
 * only made absolute, a relative one starting at the login's home. Every
 * command still passes the approval gate before it gets here.
 */
export class SshExecutor implements Executor {
  constructor(private readonly ssh: PooledSsh) {}

  root(): string {
    return this.ssh.home;
  }

  resolve(path: string): string {
    const resolved = normalizeRemotePath(path, this.ssh.home);
    if (resolved === null) throw new Error(`not a valid path: ${path}`);
    return resolved;
  }

  async exec(argv: string[], options: ExecOptions): Promise<ExecResult> {
    const cwd = options.cwd ? this.resolve(options.cwd) : this.ssh.home;
    const result = await this.ssh.exec(remoteCommandLine(argv, cwd), {
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const out: ExecResult = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? (result.signal ? 128 : -1),
      truncated: result.truncated,
    };
    if (result.timedOut) {
      throw new ExecInterruptedError("timeout", out, `the command ran past ${Math.round(options.timeoutMs / 1000)}s and was stopped`);
    }
    if (options.signal?.aborted) throw new ExecInterruptedError("aborted", out, "the turn was cancelled");
    return out;
  }

  readFile(path: string, options: { maxBytes?: number } = {}): Promise<string> {
    const at = this.resolve(path);
    return new Promise((resolve, reject) => {
      this.ssh.sftp.stat(at, (statError, stats) => {
        if (statError) {
          reject(new Error(`${path}: no such file`));
          return;
        }
        if (stats.isDirectory()) {
          reject(new Error(`${path} is a directory`));
          return;
        }
        if (options.maxBytes !== undefined && stats.size > options.maxBytes) {
          reject(new Error(`${path} is ${stats.size} bytes, more than the ${options.maxBytes} that can be read at once`));
          return;
        }
        this.ssh.sftp.readFile(at, (error, buffer) => (error ? reject(error) : resolve(buffer.toString("utf8"))));
      });
    });
  }

  async writeFile(path: string, content: string): Promise<void> {
    const at = this.resolve(path);
    // A new file's folder may not exist yet; `mkdir -p` is what the local executor does too.
    await this.ssh.exec(`mkdir -p ${shellQuote(remoteParent(at))}`, { timeoutMs: 15_000 });
    await new Promise<void>((resolve, reject) =>
      this.ssh.sftp.writeFile(at, Buffer.from(content, "utf8"), (error) => (error ? reject(error) : resolve())),
    );
  }

  removeFile(path: string): Promise<boolean> {
    const at = this.resolve(path);
    return new Promise((resolve, reject) =>
      this.ssh.sftp.unlink(at, (error) => {
        if (!error) resolve(true);
        else if ((error as { code?: number }).code === 2) resolve(false);
        else reject(error);
      }),
    );
  }
}
