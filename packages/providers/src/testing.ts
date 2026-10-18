import type { ChildHandle, ExitStatus, OutputLine, ProcessHost, RunResult, SpawnSpec } from "./process.js";

/**
 * A scripted process host, for tests.
 *
 * Each script matches argv by predicate and answers with lines and an exit.
 * Signals are recorded, and a script may hold its exit until one arrives so
 * a test can drive the interrupt path.
 */
export interface Script {
  match: (argv: readonly string[]) => boolean;
  lines?: OutputLine[];
  exit?: ExitStatus;
  /** Exit only once this signal is received (the exit above then applies). */
  waitForSignal?: "SIGINT" | "SIGTERM";
}

export class FakeProcessHost implements ProcessHost {
  readonly spawned: SpawnSpec[] = [];
  readonly signals: string[] = [];
  /** Lines written to a held stdin after spawn, across all children. */
  readonly written: string[] = [];

  constructor(private readonly scripts: Script[]) {}

  spawn(spec: SpawnSpec): ChildHandle {
    this.spawned.push(spec);
    const script = this.scripts.find((s) => s.match(spec.argv));
    const lines = script?.lines ?? [];
    const exit = script?.exit ?? { code: script ? 0 : 127, signal: null };

    let release: (() => void) | null = null;
    const gate = script?.waitForSignal
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve();

    const signals = this.signals;
    const written = this.written;
    let stdinOpen = true;
    const handle: ChildHandle = {
      lines: {
        async *[Symbol.asyncIterator]() {
          for (const line of lines) yield line;
          await gate;
        },
      },
      exited: gate.then(() => exit),
      signal(sig) {
        signals.push(sig);
        if (script?.waitForSignal === sig) release?.();
      },
      write(line) {
        if (stdinOpen) written.push(line);
      },
      endStdin() {
        stdinOpen = false;
      },
    };
    return handle;
  }

  async run(spec: SpawnSpec): Promise<RunResult> {
    const child = this.spawn(spec);
    const out: string[] = [];
    const err: string[] = [];
    for await (const { stream, line } of child.lines) (stream === "stdout" ? out : err).push(line);
    const status = await child.exited;
    return { ...status, stdout: out.join("\n"), stderr: err.join("\n") };
  }
}

export const stdout = (line: string): OutputLine => ({ stream: "stdout", line });
export const stderr = (line: string): OutputLine => ({ stream: "stderr", line });
