import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOmpCall } from "./call.js";
import { readBridgeConfig } from "./config.js";
import { BUSY, callGate } from "./lease.js";
import { watched } from "./test-host.js";

const FAKE_OMP = join(import.meta.dirname, "../../../scripts/load/fake-omp.mjs");
const PLAIN = join(import.meta.dirname, "../../providers/src/fixtures/omp-plain.jsonl");

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A scheduler socket speaking the server's protocol (apps/server's
 * `bridge-leases.ts`) with `slots` OMP slots and `waitMs` before "busy",
 * for the token "tok" only.
 */
async function scheduler(slots: number, waitMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "omp-bridge-lease-"));
  const path = join(dir, "s.sock");
  let held = 0;
  const waiting: (() => void)[] = [];
  const seen: Record<string, unknown>[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket: Socket) => {
    sockets.add(socket);
    let mine = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as { token?: string };
      seen.push(request);
      if (request.token !== "tok") return void socket.end(`${JSON.stringify({ type: "refused", reason: "no turn holds this token" })}\n`);
      const grant = () => {
        held++;
        mine = true;
        socket.write(`${JSON.stringify({ type: "granted" })}\n`);
      };
      if (held < slots) return grant();
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(next), 1);
        socket.end(`${JSON.stringify({ type: "busy" })}\n`);
      }, waitMs);
      const next = () => {
        clearTimeout(timer);
        grant();
      };
      waiting.push(next);
    });
    socket.on("close", () => {
      if (!mine) return;
      held--;
      waiting.shift()?.();
    });
    socket.on("error", () => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  );
  return { path, seen, held: () => held };
}

const config = (env: NodeJS.ProcessEnv) => readBridgeConfig({ UCCH_OMP_BIN: FAKE_OMP, ...env }, import.meta.dirname);

describe("callGate", () => {
  it("holds a turn to UCCH_BRIDGE_MAX_CALLS calls", async () => {
    const gate = callGate(config({ UCCH_BRIDGE_MAX_CALLS: "2" }));
    expect(await gate.enter()).toHaveProperty("release");
    expect(await gate.enter()).toHaveProperty("release");
    expect(await gate.enter()).toEqual({
      refused: "this turn has used its 2 omp calls (UCCH_BRIDGE_MAX_CALLS); carry on without the omp tools",
    });
  });

  it("takes a slot from the scheduler per call, held until the call releases it", async () => {
    const socket = await scheduler(1, 1000);
    const gate = callGate(config({ UCCH_SCHEDULER_SOCK: socket.path, UCCH_BRIDGE_TOKEN: "tok" }));
    const lease = await gate.enter();
    expect(lease).toHaveProperty("release");
    expect(socket.seen).toEqual([{ type: "lease", token: "tok" }]);
    expect(socket.held()).toBe(1);
    (lease as { release(): void }).release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.held()).toBe(0);
  });

  it("with one OMP slot, a second concurrent call waits, then reports busy -- and is not counted", async () => {
    const socket = await scheduler(1, 150);
    const gate = callGate(config({ UCCH_SCHEDULER_SOCK: socket.path, UCCH_BRIDGE_TOKEN: "tok", UCCH_BRIDGE_MAX_CALLS: "2" }));
    const first = await gate.enter();
    const started = Date.now();
    expect(await gate.enter()).toEqual({ refused: BUSY });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    (first as { release(): void }).release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The busy call did not use the budget: one more fits.
    expect(await gate.enter()).toHaveProperty("release");
  });

  it("gets the slot when it frees within the wait", async () => {
    const socket = await scheduler(1, 2000);
    const gate = callGate(config({ UCCH_SCHEDULER_SOCK: socket.path, UCCH_BRIDGE_TOKEN: "tok" }));
    const first = (await gate.enter()) as { release(): void };
    const second = gate.enter();
    setTimeout(() => first.release(), 50);
    expect(await second).toHaveProperty("release");
  });

  it("refuses to run unmetered: no scheduler, a refused token, or no answer", async () => {
    const missing = callGate(config({ UCCH_SCHEDULER_SOCK: join(tmpdir(), "no-such-ucch.sock") }));
    expect(await missing.enter()).toEqual({ refused: expect.stringMatching(/^could not reach the UCCH scheduler: /) });

    const socket = await scheduler(1, 1000);
    const wrong = callGate(config({ UCCH_SCHEDULER_SOCK: socket.path, UCCH_BRIDGE_TOKEN: "stale" }));
    expect(await wrong.enter()).toEqual({ refused: "the UCCH scheduler refused the call: no turn holds this token" });

    const muted = new Set<Socket>();
    const silent = createServer((socket) => void muted.add(socket));
    const dir = mkdtempSync(join(tmpdir(), "omp-bridge-silent-"));
    await new Promise<void>((resolve) => silent.listen(join(dir, "s.sock"), resolve));
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => {
        for (const socket of muted) socket.destroy();
        return new Promise<void>((resolve) => silent.close(() => resolve()));
      },
    );
    const mute = callGate(config({ UCCH_SCHEDULER_SOCK: join(dir, "s.sock"), UCCH_BRIDGE_TOKEN: "tok" }), { answerWaitMs: 50 });
    expect(await mute.enter()).toEqual({ refused: BUSY });
  });
});

describe("a bridge call behind the gate", () => {
  it("is told busy without starting omp, and starts omp once a slot is free", async () => {
    const socket = await scheduler(1, 100);
    const env = { UCCH_SCHEDULER_SOCK: socket.path, UCCH_BRIDGE_TOKEN: "tok" };
    const gate = callGate(config(env));
    const holder = (await gate.enter()) as { release(): void };

    const { host, spawned } = watched();
    const ctx = { config: config(env), host, parentEnv: { PATH: process.env.PATH, FAKE_OMP_FIXTURE: PLAIN }, gate };
    const call = { tools: [], model: "@smol", prompt: "x", answer: {} };
    expect(await runOmpCall(ctx, call)).toEqual({ content: [{ type: "text", text: BUSY }], isError: true });
    expect(spawned).toEqual([]);

    holder.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const result = await runOmpCall(ctx, call);
    expect(result.isError).toBeUndefined();
    expect(spawned).toHaveLength(1);
    // The call gave its slot back when it ended.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.held()).toBe(0);
  });
});
