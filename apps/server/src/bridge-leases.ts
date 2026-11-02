import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { TurnScheduler } from "./turn-scheduler.js";

/**
 * Where `omp-bridge` asks for an OMP slot (solution §10.5).
 *
 * A Claude Code or Codex turn's bridge starts an `omp` process per tool
 * call, and those count against `OMP_TURN_TOTAL` like OMP turns. The bridge
 * is a child of the CLI, not of this server, so it asks over a local Unix
 * socket (`UCCH_SCHEDULER_SOCK`), one connection per call:
 *
 *   bridge -> {"type":"lease","token":"<the turn's token>"}\n
 *   server -> {"type":"granted"}\n      the slot is the bridge's while the
 *                                       connection stays open; closing it
 *                                       gives the slot back
 *          or {"type":"busy"}\n         no slot within the wait (30 s)
 *          or {"type":"refused","reason":"…"}\n
 *
 * The connection is the lease, so a bridge that crashes, or a CLI killed
 * with its children, can never keep a slot: the socket closes and the slot
 * comes back.
 *
 * The token names the turn the bridge was started for, registered when the
 * turn's MCP config is written (OM6.4) and revoked when the turn ends. Any
 * process in the container can reach the socket; without a live token it
 * gets nothing, so nothing outside a turn can take the server's OMP slots.
 */

/** How long a bridge call waits for a slot before it is told "busy". */
export const LEASE_WAIT_MS = 30_000;

/** A request line is a token and a type; anything longer is not one. */
const MAX_REQUEST_BYTES = 4096;

interface Holder {
  ownerId: string;
  threadId: string;
}

export interface BridgeLeaseOptions {
  waitMs?: number;
}

export class BridgeLeases {
  readonly #scheduler: TurnScheduler;
  readonly #waitMs: number;
  readonly #tokens = new Map<string, Holder>();
  readonly #sockets = new Set<Socket>();
  #server: Server | null = null;

  constructor(scheduler: TurnScheduler, options: BridgeLeaseOptions = {}) {
    this.#scheduler = scheduler;
    this.#waitMs = options.waitMs ?? LEASE_WAIT_MS;
  }

  /**
   * A token for one turn's bridge: what goes into its MCP config as
   * `UCCH_BRIDGE_TOKEN`. `revoke` once the turn is over; slots the bridge
   * still holds come back when its connections close, as they do when the
   * CLI exits.
   */
  register(holder: Holder): { token: string; revoke(): void } {
    const token = randomBytes(24).toString("base64url");
    this.#tokens.set(token, holder);
    return { token, revoke: () => void this.#tokens.delete(token) };
  }

  /** Listens on `path`, owner-only. A socket file left by an earlier run is replaced. */
  async listen(path: string): Promise<void> {
    await rm(path, { force: true });
    const server = createServer((socket) => this.#serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
    this.#server = server;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  #serve(socket: Socket): void {
    this.#sockets.add(socket);
    const gone = new AbortController();
    let release: (() => void) | null = null;
    let asked = false;
    let buffer = "";

    const reply = (frame: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
    };
    const refuse = (reason: string) => {
      reply({ type: "refused", reason });
      socket.end();
    };

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (asked) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) return refuse("request too long");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      asked = true;
      let request: { type?: unknown; token?: unknown };
      try {
        request = JSON.parse(buffer.slice(0, end)) as typeof request;
      } catch {
        return refuse("not a lease request");
      }
      if (request.type !== "lease") return refuse("not a lease request");
      const holder = typeof request.token === "string" ? this.#tokens.get(request.token) : undefined;
      if (!holder) return refuse("no turn holds this token: the bridge belongs to a turn that is over");
      void this.#scheduler
        .lease({ ...holder, waitMs: this.#waitMs, signal: gone.signal })
        .then((granted) => {
          if (!granted) {
            reply({ type: "busy" });
            socket.end();
            return;
          }
          if (gone.signal.aborted) return granted();
          release = granted;
          reply({ type: "granted" });
        });
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      this.#sockets.delete(socket);
      gone.abort();
      release?.();
      release = null;
    });
  }
}
