import type { ChildHandle, ExitStatus, ProcessHost } from "./process.js";
import type {
  OmpChunk,
  OmpClientFrame,
  OmpCommand,
  OmpFrame,
  OmpReady,
  OmpResponse,
} from "./omp-rpc-types.js";

/**
 * A client for one OMP process in `--mode rpc` / `rpc-ui`
 * (documentation/architecture.md §7).
 *
 * One JSON frame per line each way. The rules it keeps, from the
 * [rpc](https://omp.sh/docs/rpc) docs and what the pinned version does:
 *
 * 1. Nothing is sent before `ready`; a process that is not ready in 20 s,
 *    or exits first (an unknown `--resume` id, an unknown `--model`), fails
 *    the start with its stderr.
 * 2. Protocol v2 is negotiated straight away. Above 1 MiB, frames then
 *    arrive as `rpc_chunk` slices, reassembled here strictly: in order,
 *    consistent, at most 64 MiB, or the whole frame is dropped with an
 *    `rpc_frame_error`. If negotiation fails the session stays on v1.
 * 3. Responses are matched to commands by `id`, never by order: OMP runs
 *    some commands concurrently.
 * 4. Unknown frames and fields go to `onFrame` like any other.
 * 5. Stdout is protocol only. Stderr is kept, the last 64 KB, for the
 *    message when something fails.
 * 6. Shutdown is closing stdin: OMP finishes what it accepted and exits 0.
 *
 * `onFrame` is called synchronously from the read loop, in order. It must
 * not block: a provider queues the frame and handles it elsewhere.
 */

export interface OmpRpcOptions {
  host: ProcessHost;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Every frame that is not the answer to a command, in order. */
  onFrame(frame: OmpFrame): void;
  /** Each stderr line, for the server log. Never parsed. */
  onStderr?(line: string): void;
  /** What the client itself has to say: a failed negotiation, a frame it could not read. */
  onLog?(message: string): void;
  /** How long `ready` may take. */
  readyTimeoutMs?: number;
  /** How long SIGTERM gets before SIGKILL, in `kill()`. */
  killGraceMs?: number;
}

const READY_TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_BYTES = 64 * 1024;
/** v1's limit, until `ready` says otherwise. */
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

interface Pending {
  resolve(response: OmpResponse<unknown>): void;
  reject(error: Error): void;
}

interface Assembly {
  count: number;
  byteLength: number;
  received: number;
  parts: Buffer[];
}

export class OmpRpc {
  readonly #child: ChildHandle;
  readonly #options: OmpRpcOptions;
  readonly #pending = new Map<string, Pending>();
  readonly #chunks = new Map<string, Assembly>();
  readonly #exited: Promise<ExitStatus>;
  #next = 0;
  #stderr = "";
  #ready: OmpReady | null = null;
  #onReady: ((frame: OmpReady) => void) | null = null;
  #gone: Error | null = null;
  #spawnError: Error | null = null;
  #protocolVersion = 1;

  private constructor(options: OmpRpcOptions) {
    this.#options = options;
    this.#child = options.host.spawn({ argv: options.argv, cwd: options.cwd, env: options.env, holdStdin: true });
    this.#exited = this.#read();
  }

  /** Spawns OMP and resolves once it is ready and the protocol is settled. */
  static async start(options: OmpRpcOptions): Promise<OmpRpc> {
    const rpc = new OmpRpc(options);
    await rpc.#waitReady(options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    await rpc.#negotiate();
    return rpc;
  }

  /** The `ready` frame: protocol versions and frame limits. */
  get ready(): OmpReady {
    return this.#ready!;
  }

  get protocolVersion(): number {
    return this.#protocolVersion;
  }

  /** The end of OMP's stderr, for an error message. */
  get stderrTail(): string {
    return this.#stderr;
  }

  /** Resolves when the process has exited, with how. */
  get exited(): Promise<ExitStatus> {
    return this.#exited;
  }

  /**
   * Sends a command and resolves with its response, whether it succeeded or
   * not. Rejects only when the process is gone. A `prompt` resolving means
   * the prompt was scheduled; the turn is over at a terminal `agent_end`.
   */
  request<T = unknown>(command: OmpCommand): Promise<OmpResponse<T>> {
    if (this.#gone) return Promise.reject(this.#gone);
    const id = `omp-${++this.#next}`;
    return new Promise<OmpResponse<T>>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as Pending["resolve"], reject });
      try {
        this.#write({ ...command, id });
      } catch (error) {
        this.#pending.delete(id);
        reject(error as Error);
      }
    });
  }

  /** An answer that is not a command: a UI response, a host tool's result. */
  send(frame: OmpClientFrame): void {
    if (this.#gone) throw this.#gone;
    this.#write(frame);
  }

  /** Closes stdin, which OMP takes as "finish and exit", and waits for it. */
  close(): Promise<ExitStatus> {
    this.#child.endStdin();
    return this.#exited;
  }

  /** SIGTERM, and SIGKILL if the process is still there after the grace period. */
  async kill(): Promise<void> {
    this.#child.signal("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.#options.killGraceMs ?? KILL_GRACE_MS);
    });
    const outcome = await Promise.race([this.#exited, grace]);
    clearTimeout(timer);
    if (outcome === "late") {
      this.#child.signal("SIGKILL");
      await this.#exited;
    }
  }

  #write(frame: object): void {
    const line = JSON.stringify(frame);
    // UCCH never needs to chunk what it sends; a frame this large is a bug
    // upstream, and OMP would refuse it anyway.
    const limit = this.#ready?.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (Buffer.byteLength(line) > limit) {
      throw new Error(`OMP frame of ${Buffer.byteLength(line)} bytes is over the ${limit}-byte limit`);
    }
    this.#child.write(line);
  }

  async #waitReady(timeoutMs: number): Promise<void> {
    if (this.#ready) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          this.#onReady = () => resolve();
        }),
        this.#exited.then((status) => {
          if (this.#ready) return;
          throw this.#spawnError ?? new Error(`omp exited (${describe(status)}) before it was ready${tail(this.#stderr)}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`omp was not ready after ${Math.round(timeoutMs / 1000)} s${tail(this.#stderr)}`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (!this.#gone) await this.kill();
      throw error;
    } finally {
      clearTimeout(timer);
      this.#onReady = null;
    }
  }

  async #negotiate(): Promise<void> {
    if (!this.#ready?.supportedProtocolVersions?.includes(2)) {
      this.#options.onLog?.("omp does not offer RPC protocol v2; staying on v1 (1 MiB frames)");
      return;
    }
    const response = await this.request<{ protocolVersion?: number }>({ type: "negotiate_protocol", protocolVersion: 2 });
    if (response.success && response.data?.protocolVersion === 2) {
      this.#protocolVersion = 2;
    } else {
      this.#options.onLog?.(`omp refused RPC protocol v2 (${response.error ?? "no reason"}); staying on v1`);
    }
  }

  /** The read loop: runs until the process's streams close. */
  async #read(): Promise<ExitStatus> {
    try {
      for await (const { stream, line } of this.#child.lines) {
        if (stream === "stderr") {
          this.#stderr = (this.#stderr + line + "\n").slice(-STDERR_TAIL_BYTES);
          this.#options.onStderr?.(line);
          continue;
        }
        this.#line(line);
      }
    } catch (error) {
      // The child never started: most often the binary is not installed.
      this.#spawnError = error instanceof Error ? error : new Error(String(error));
      this.#gone = this.#spawnError;
    }
    const status = await this.#child.exited;
    this.#gone ??= new Error(`omp exited (${describe(status)})${tail(this.#stderr)}`);
    for (const pending of this.#pending.values()) pending.reject(this.#gone);
    this.#pending.clear();
    return status;
  }

  #line(line: string): void {
    if (line.trim() === "") return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.#options.onLog?.(`omp wrote a line that is not JSON: ${line.slice(0, 200)}`);
      return;
    }
    if (!frame || typeof frame !== "object" || typeof (frame as OmpFrame).type !== "string") {
      this.#options.onLog?.(`omp wrote a frame without a type: ${line.slice(0, 200)}`);
      return;
    }
    this.#frame(frame as OmpFrame);
  }

  #frame(frame: OmpFrame): void {
    if (frame.type === "rpc_chunk") return this.#chunk(frame as OmpChunk);
    if (frame.type === "ready" && !this.#ready) {
      this.#ready = frame as OmpReady;
      this.#onReady?.(this.#ready);
      return;
    }
    if (frame.type === "response") {
      const response = frame as OmpResponse;
      const pending = response.id ? this.#pending.get(response.id) : undefined;
      if (pending) {
        this.#pending.delete(response.id!);
        pending.resolve(response);
        return;
      }
      if (response.command === "parse") {
        // OMP could not read a line UCCH sent. Always a bug on this side.
        this.#options.onLog?.(`omp could not parse a frame UCCH sent: ${response.error ?? "no reason given"}`);
      }
    }
    this.#deliver(frame);
  }

  #deliver(frame: OmpFrame): void {
    try {
      this.#options.onFrame(frame);
    } catch (error) {
      this.#options.onLog?.(`onFrame threw on ${frame.type}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #chunk(chunk: OmpChunk): void {
    const id = typeof chunk.chunkId === "string" ? chunk.chunkId : "";
    const fail = (error: string) => {
      this.#chunks.delete(id);
      this.#deliver({ type: "rpc_frame_error", chunkId: id, error });
    };
    const limit = this.#ready?.maxReassembledFrameBytes ?? DEFAULT_MAX_REASSEMBLED_BYTES;
    if (!id) return fail("rpc_chunk without a chunkId");
    if (!Number.isInteger(chunk.count) || chunk.count < 1) return fail(`bad count ${String(chunk.count)}`);
    if (!Number.isInteger(chunk.byteLength) || chunk.byteLength < 1 || chunk.byteLength > limit) {
      return fail(`frame of ${String(chunk.byteLength)} bytes is over the ${limit}-byte limit`);
    }
    if (typeof chunk.data !== "string" || chunk.data.length % 4 !== 0 || !BASE64.test(chunk.data)) {
      return fail(`slice ${String(chunk.index)} is not base64`);
    }

    let assembly = this.#chunks.get(id);
    if (!assembly) {
      if (chunk.index !== 0) return fail(`first slice seen is ${String(chunk.index)}, not 0`);
      assembly = { count: chunk.count, byteLength: chunk.byteLength, received: 0, parts: [] };
      this.#chunks.set(id, assembly);
    }
    if (chunk.count !== assembly.count || chunk.byteLength !== assembly.byteLength) {
      return fail("slices disagree on count or byteLength");
    }
    if (chunk.index !== assembly.parts.length) {
      return fail(`slice ${String(chunk.index)} arrived where ${assembly.parts.length} was due`);
    }
    const part = Buffer.from(chunk.data, "base64");
    assembly.received += part.length;
    if (assembly.received > assembly.byteLength) return fail("slices add up to more than byteLength");
    assembly.parts.push(part);
    if (assembly.parts.length < assembly.count) return;

    this.#chunks.delete(id);
    if (assembly.received !== assembly.byteLength) {
      return fail(`slices add up to ${assembly.received} bytes, not ${assembly.byteLength}`);
    }
    let frame: unknown;
    try {
      frame = JSON.parse(Buffer.concat(assembly.parts).toString("utf8"));
    } catch {
      return fail("reassembled frame is not JSON");
    }
    if (!frame || typeof frame !== "object" || typeof (frame as OmpFrame).type !== "string") {
      return fail("reassembled frame has no type");
    }
    if ((frame as OmpFrame).type === "rpc_chunk") return fail("a chunk inside a chunk");
    this.#frame(frame as OmpFrame);
  }
}

function describe(status: ExitStatus): string {
  return status.signal ? `signal ${status.signal}` : `code ${String(status.code)}`;
}

function tail(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed ? `: ${trimmed.slice(-2000)}` : "";
}
