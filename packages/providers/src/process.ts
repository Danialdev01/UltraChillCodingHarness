import { spawn } from "node:child_process";

/**
 * The process boundary.
 *
 * The spec puts the CLIs inside the project container, reached through
 * `docker exec`. There is no container runtime yet, so they run on the host
 * in the workspace directory -- the same trade the `bash` tool and the
 * terminal already make, behind the same gate. This interface is what keeps
 * that a swap rather than a rewrite: a `DockerProcessHost` implements the
 * same two methods and nothing in the providers changes.
 *
 * Commands are argv arrays, never shell strings. The prompt travels on
 * stdin, never in argv: it has no length limit there and does not appear in
 * `ps` for every other process on the machine to read.
 */

export interface SpawnSpec {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** Written to the child and closed. Absent closes stdin immediately. */
  stdin?: string;
}

export interface OutputLine {
  stream: "stdout" | "stderr";
  line: string;
}

export interface ExitStatus {
  code: number | null;
  signal: string | null;
}

export interface ChildHandle {
  /** Complete lines, in arrival order across both streams. */
  lines: AsyncIterable<OutputLine>;
  exited: Promise<ExitStatus>;
  signal(sig: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
}

export interface RunResult extends ExitStatus {
  stdout: string;
  stderr: string;
}

export interface ProcessHost {
  /** A streaming child: for turns. */
  spawn(spec: SpawnSpec): ChildHandle;
  /** A one-shot child, output buffered: for probes and version checks. */
  run(spec: SpawnSpec, options?: { timeoutMs?: number }): Promise<RunResult>;
}

/** What the CLIs exit with after SIGTERM: 128 + 15. */
export const EXIT_SIGTERM = 143;
/** And after SIGINT: 128 + 2. */
export const EXIT_SIGINT = 130;

/**
 * Splits a byte stream into lines, keeping whatever has not been terminated.
 *
 * JSONL arrives split across chunk boundaries as a matter of course, and a
 * `JSON.parse` on half a line is the bug every stream reader ships once.
 * `flush()` returns the unterminated tail when the stream ends, because the
 * last line of a stream frequently has no newline after it.
 */
export function splitLines(): { push(chunk: string): string[]; flush(): string | null } {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      const lines: string[] = [];
      let at: number;
      while ((at = pending.indexOf("\n")) !== -1) {
        let line = pending.slice(0, at);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        lines.push(line);
        pending = pending.slice(at + 1);
      }
      return lines;
    },
    flush() {
      if (pending.length === 0) return null;
      const tail = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      pending = "";
      return tail.length === 0 ? null : tail;
    },
  };
}

/** How long a process gets to exit on SIGTERM before SIGKILL follows. */
const KILL_GRACE_MS = 2_000;

/**
 * Runs children on the host.
 *
 * Each child is its own process group, so a signal reaches everything the
 * CLI itself started -- the bash tool trees Claude Code runs, for one -- and
 * a backgrounded server cannot outlive the turn that started it.
 */
export class HostProcessHost implements ProcessHost {
  spawn(spec: SpawnSpec): ChildHandle {
    const [command, ...args] = spec.argv;
    if (!command) throw new Error("spawn requires a command");

    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const signalGroup = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    // A queue between the event-driven streams and the pull-driven
    // iterator, so no line is lost while the consumer is awaiting a write.
    const queue: OutputLine[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    let spawnError: Error | null = null;
    const notify = () => {
      wake?.();
      wake = null;
    };

    const attach = (stream: "stdout" | "stderr", source: NodeJS.ReadableStream) => {
      const splitter = splitLines();
      source.setEncoding("utf8");
      source.on("data", (chunk: string) => {
        for (const line of splitter.push(chunk)) queue.push({ stream, line });
        notify();
      });
      source.on("end", () => {
        const tail = splitter.flush();
        if (tail !== null) queue.push({ stream, line: tail });
        notify();
      });
    };
    attach("stdout", child.stdout);
    attach("stderr", child.stderr);

    const exited = new Promise<ExitStatus>((settle) => {
      child.on("error", (error) => {
        // Most often ENOENT: the binary is not installed. Recorded so the
        // consumer can say that, then settled as an exit so nothing hangs.
        spawnError = error;
        closed = true;
        notify();
        settle({ code: null, signal: null });
      });
      child.on("close", (code, signal) => {
        closed = true;
        notify();
        settle({ code, signal });
      });
    });

    if (spec.stdin !== undefined) {
      child.stdin.on("error", () => {
        /* the child closed its end first; its exit status says why */
      });
      child.stdin.end(spec.stdin);
    } else {
      child.stdin.end();
    }

    const lines: AsyncIterable<OutputLine> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<OutputLine>> {
            for (;;) {
              const line = queue.shift();
              if (line) return { value: line, done: false };
              if (closed) {
                if (spawnError) throw new Error(`could not run ${command}: ${spawnError.message}`);
                return { value: undefined, done: true };
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
          },
        };
      },
    };

    let killTimer: NodeJS.Timeout | undefined;
    return {
      lines,
      exited,
      signal(sig) {
        signalGroup(sig);
        if (sig === "SIGTERM" && !killTimer) {
          // A process that ignores SIGTERM does not get to hold the turn open.
          killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
          killTimer.unref();
          void exited.then(() => clearTimeout(killTimer));
        }
      },
    };
  }

  async run(spec: SpawnSpec, options: { timeoutMs?: number } = {}): Promise<RunResult> {
    const child = this.spawn(spec);
    const timer = options.timeoutMs
      ? setTimeout(() => child.signal("SIGTERM"), options.timeoutMs)
      : undefined;
    timer?.unref();
    const out: string[] = [];
    const err: string[] = [];
    try {
      for await (const { stream, line } of child.lines) (stream === "stdout" ? out : err).push(line);
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
    const status = await child.exited;
    clearTimeout(timer);
    return { ...status, stdout: out.join("\n"), stderr: err.join("\n") };
  }
}
