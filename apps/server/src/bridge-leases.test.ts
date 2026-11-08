import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeLeases } from "./bridge-leases.js";
import { TurnScheduler } from "./turn-scheduler.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(ompTotal: number, waitMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-leases-"));
  const path = join(dir, "s.sock");
  const scheduler = new TurnScheduler({ cliPerUser: 2, cliTotal: 5, nativeTotal: 5, ompTotal });
  const leases = new BridgeLeases(scheduler, { waitMs });
  await leases.listen(path);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => leases.close());
  return { path, scheduler, leases };
}

/** What the bridge does: one connection, one request, then whatever the server answers. */
function ask(path: string, line: string) {
  const socket: Socket = createConnection(path);
  cleanups.push(() => void socket.destroy());
  const answer = new Promise<Record<string, unknown> | null>((resolve) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end >= 0) resolve(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>);
    });
    socket.on("close", () => resolve(null));
    socket.on("error", () => resolve(null));
  });
  socket.write(`${line}\n`);
  return { socket, answer };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("BridgeLeases", () => {
  it("grants a registered turn's bridge an OMP slot, held while the connection is open", async () => {
    const { path, scheduler, leases } = await serve(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const { token } = leases.register({ ownerId: "u1", threadId: "t1" });
    const call = ask(path, JSON.stringify({ type: "lease", token }));
    expect(await call.answer).toEqual({ type: "granted" });
    expect(scheduler.stats().running.omp).toBe(1);
    call.socket.end();
    await settle();
    expect(scheduler.stats().running.omp).toBe(0);
  });

  it("with OMP_TURN_TOTAL=1, a second concurrent call waits, then is told busy", async () => {
    const { path, scheduler, leases } = await serve(1, 150);
    const { token } = leases.register({ ownerId: "u1", threadId: "t1" });
    const first = ask(path, JSON.stringify({ type: "lease", token }));
    expect(await first.answer).toEqual({ type: "granted" });

    const started = Date.now();
    const second = ask(path, JSON.stringify({ type: "lease", token }));
    await settle();
    expect(scheduler.stats().waiting.omp).toBe(1);
    expect(await second.answer).toEqual({ type: "busy" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(scheduler.stats()).toMatchObject({ running: { omp: 1 }, waiting: { omp: 0 } });
  });

  it("hands the slot on when the holder's connection closes, crash or not", async () => {
    const { path, leases } = await serve(1, 2000);
    const { token } = leases.register({ ownerId: "u1", threadId: "t1" });
    const first = ask(path, JSON.stringify({ type: "lease", token }));
    await first.answer;
    const second = ask(path, JSON.stringify({ type: "lease", token }));
    await settle();
    first.socket.destroy();
    expect(await second.answer).toEqual({ type: "granted" });
  });

  it("gives up a waiting call's place when its bridge goes away", async () => {
    const { path, scheduler, leases } = await serve(1, 5000);
    const { token } = leases.register({ ownerId: "u1", threadId: "t1" });
    await ask(path, JSON.stringify({ type: "lease", token })).answer;
    const waiting = ask(path, JSON.stringify({ type: "lease", token }));
    await settle();
    expect(scheduler.stats().waiting.omp).toBe(1);
    waiting.socket.destroy();
    await settle();
    expect(scheduler.stats().waiting.omp).toBe(0);
  });

  it("refuses an unknown or revoked token, and anything that is not a lease request", async () => {
    const { path, scheduler, leases } = await serve(2);
    const unknown = ask(path, JSON.stringify({ type: "lease", token: "nope" }));
    expect(await unknown.answer).toMatchObject({ type: "refused" });
    const lease = leases.register({ ownerId: "u1", threadId: "t1" });
    lease.revoke();
    expect(await ask(path, JSON.stringify({ type: "lease", token: lease.token })).answer).toMatchObject({ type: "refused" });
    expect(await ask(path, "not json").answer).toEqual({ type: "refused", reason: "not a lease request" });
    expect(await ask(path, JSON.stringify({ type: "other" })).answer).toEqual({ type: "refused", reason: "not a lease request" });
    expect(scheduler.stats().running.omp).toBe(0);
  });

  it("replaces a socket file left by an earlier run", async () => {
    const { path, leases } = await serve(1);
    await leases.close();
    const again = new BridgeLeases(new TurnScheduler({ cliPerUser: 1, cliTotal: 1, nativeTotal: 1, ompTotal: 1 }));
    await again.listen(path);
    cleanups.push(() => again.close());
    const { token } = again.register({ ownerId: "u", threadId: "t" });
    expect(await ask(path, JSON.stringify({ type: "lease", token })).answer).toEqual({ type: "granted" });
  });
});

describe("BridgeLeases spawn frames (ucch_agent)", () => {
  it("runs the subagent for the token's turn and answers with its result", async () => {
    const { path, leases } = await serve(1);
    const seen: unknown[] = [];
    leases.setSpawner(async (holder, frame) => {
      seen.push({ holder, frame });
      return { text: "done" };
    });
    const { token } = leases.register({ ownerId: "u1", threadId: "t1" });
    const call = ask(path, JSON.stringify({ type: "spawn", token, description: "Research", task: "Look", model: "gpt6 sol" }));
    expect(await call.answer).toEqual({ type: "result", text: "done" });
    expect(seen).toEqual([{ holder: { ownerId: "u1", threadId: "t1" }, frame: { description: "Research", task: "Look", model: "gpt6 sol" } }]);
  });

  it("refuses a spawn with no live token, and stops the subagent when the bridge hangs up", async () => {
    const { path, leases } = await serve(1);
    let stopped = false;
    leases.setSpawner(
      (_holder, _frame, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            stopped = true;
            resolve({ error: "stopped" });
          });
        }),
    );
    expect(await ask(path, JSON.stringify({ type: "spawn", token: "nope", task: "x" })).answer).toMatchObject({ type: "refused" });
    const { token } = leases.register({ ownerId: "u1", threadId: "t1" });
    const call = ask(path, JSON.stringify({ type: "spawn", token, task: "x" }));
    await settle();
    call.socket.destroy();
    await settle();
    expect(stopped).toBe(true);
  });
});
