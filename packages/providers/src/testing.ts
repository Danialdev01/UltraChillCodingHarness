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

/**
 * A child the test drives by hand: it writes the child's stdout and stderr
 * when it likes, sees every line written to its stdin, and decides when it
 * exits. For a protocol that answers what the host says, which a fixed
 * script cannot.
 */
export class ManualChild {
  readonly written: string[] = [];
  readonly signals: string[] = [];
  stdinOpen = true;
  /** Called with each line the host writes, after it is recorded. */
  onWrite: ((line: string) => void) | null = null;
  /** Called with each signal, after it is recorded. */
  onSignal: ((sig: string) => void) | null = null;
  readonly handle: ChildHandle;

  #queue: OutputLine[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  #exit!: (status: ExitStatus) => void;

  constructor(readonly spec: SpawnSpec) {
    const exited = new Promise<ExitStatus>((resolve) => {
      this.#exit = resolve;
    });
    const child = this;
    this.handle = {
      lines: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const next = child.#queue.shift();
            if (next) {
              yield next;
              continue;
            }
            if (child.#ended) return;
            await new Promise<void>((resolve) => {
              child.#wake = resolve;
            });
          }
        },
      },
      exited,
      signal(sig) {
        child.signals.push(sig);
        child.onSignal?.(sig);
      },
      write(line) {
        if (!child.stdinOpen) return;
        child.written.push(line);
        child.onWrite?.(line);
      },
      endStdin() {
        child.stdinOpen = false;
      },
    };
  }

  /** The frames written so far, parsed. */
  get frames(): Record<string, unknown>[] {
    return this.written.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  emit(line: string, stream: "stdout" | "stderr" = "stdout"): void {
    this.#queue.push({ stream, line });
    this.#wake?.();
    this.#wake = null;
  }

  /** Closes both streams and exits. */
  exit(status: ExitStatus = { code: 0, signal: null }): void {
    this.#ended = true;
    this.#wake?.();
    this.#wake = null;
    this.#exit(status);
  }
}

/** A host whose children are `ManualChild`ren; `onSpawn` sets each one up. */
export class ManualProcessHost implements ProcessHost {
  readonly children: ManualChild[] = [];

  constructor(private readonly onSpawn: (child: ManualChild) => void = () => {}) {}

  spawn(spec: SpawnSpec): ChildHandle {
    const child = new ManualChild(spec);
    this.children.push(child);
    this.onSpawn(child);
    return child.handle;
  }

  async run(): Promise<RunResult> {
    throw new Error("ManualProcessHost runs streaming children only");
  }
}
