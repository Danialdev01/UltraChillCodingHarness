import { describe, expect, it } from "vitest";
import { TurnScheduler, type TurnKind, type TurnRequest } from "./turn-scheduler.js";

const limits = { cliPerUser: 2, cliTotal: 3, nativeTotal: 2 };

/** Requests a turn and keeps what became of it. */
function ask(scheduler: TurnScheduler, ownerId: string, kind: TurnKind, threadId: string, extra: Partial<TurnRequest> = {}) {
  const turn = {
    threadId,
    started: false,
    failed: null as Error | null,
    release: () => {},
    aheads: [] as number[],
  };
  scheduler
    .acquire({ ownerId, kind, threadId, onAhead: (ahead) => turn.aheads.push(ahead), ...extra })
    .then(
      (release) => {
        turn.started = true;
        turn.release = release;
      },
      (error: Error) => {
        turn.failed = error;
      },
    );
  return turn;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("TurnScheduler", () => {
  it("starts turns while they fit, and the next one as each ends", async () => {
    const scheduler = new TurnScheduler(limits);
    const turns = ["a", "b", "c", "d"].map((owner) => ask(scheduler, owner, "cli", `t-${owner}`));
    await settle();
    expect(turns.map((t) => t.started)).toEqual([true, true, true, false]);
    expect(scheduler.stats()).toEqual({ running: { cli: 3, native: 0, omp: 0 }, waiting: { cli: 1, native: 0, omp: 0 } });
    turns[1]!.release();
    await settle();
    expect(turns[3]!.started).toBe(true);
  });

  it("holds an account to its own CLI limit while others run", async () => {
    const scheduler = new TurnScheduler({ ...limits, cliTotal: 10 });
    const mine = [1, 2, 3].map((n) => ask(scheduler, "me", "cli", `me-${n}`));
    const theirs = ask(scheduler, "you", "cli", "you-1");
    await settle();
    expect(mine.map((t) => t.started)).toEqual([true, true, false]);
    expect(theirs.started).toBe(true);
    mine[0]!.release();
    await settle();
    expect(mine[2]!.started).toBe(true);
  });

  it("caps native turns apart from CLI ones", async () => {
    const scheduler = new TurnScheduler(limits);
    const native = [1, 2, 3].map((n) => ask(scheduler, `n${n}`, "native", `n-${n}`));
    const cli = ask(scheduler, "c", "cli", "c-1");
    await settle();
    expect(native.map((t) => t.started)).toEqual([true, true, false]);
    expect(cli.started).toBe(true);
  });

  it("takes waiting accounts in turn, not one account's whole queue first", async () => {
    const scheduler = new TurnScheduler({ cliPerUser: 5, cliTotal: 1, nativeTotal: 1 });
    const first = ask(scheduler, "busy", "cli", "busy-0");
    const busy = [1, 2, 3].map((n) => ask(scheduler, "busy", "cli", `busy-${n}`));
    const quiet = ask(scheduler, "quiet", "cli", "quiet-1");
    await settle();
    const order: string[] = [];
    let running = first;
    for (let i = 0; i < 4; i++) {
      running.release();
      await settle();
      running = [...busy, quiet].find((t) => t.started && !order.includes(t.threadId))!;
      order.push(running.threadId);
    }
    expect(order).toEqual(["busy-1", "quiet-1", "busy-2", "busy-3"]);
  });

  it("tells each waiting turn how many are ahead of it, as that changes", async () => {
    const scheduler = new TurnScheduler({ cliPerUser: 5, cliTotal: 1, nativeTotal: 1 });
    const running = ask(scheduler, "a", "cli", "a-0");
    const a1 = ask(scheduler, "a", "cli", "a-1");
    const b1 = ask(scheduler, "b", "cli", "b-1");
    const a2 = ask(scheduler, "a", "cli", "a-2");
    await settle();
    expect(running.aheads).toEqual([]);
    expect([a1.aheads, b1.aheads, a2.aheads]).toEqual([[0], [1], [2]]);
    expect(scheduler.aheadOf("a-2")).toBe(2);
    running.release();
    await settle();
    // a-1 started, so `b` is served next: b-1 first, then a-2.
    expect([b1.aheads, a2.aheads]).toEqual([[1, 0], [2, 1]]);
    expect(scheduler.aheadOf("a-1")).toBeNull();
  });

  it("gives up a waiting turn's place when it is cancelled", async () => {
    const scheduler = new TurnScheduler({ cliPerUser: 5, cliTotal: 1, nativeTotal: 1 });
    const running = ask(scheduler, "a", "cli", "a-0");
    const controller = new AbortController();
    const cancelled = ask(scheduler, "b", "cli", "b-1", { signal: controller.signal });
    const after = ask(scheduler, "c", "cli", "c-1");
    await settle();
    controller.abort();
    await settle();
    expect(cancelled.failed?.name).toBe("AbortError");
    expect(after.aheads).toEqual([1, 0]);
    running.release();
    await settle();
    expect(cancelled.started).toBe(false);
    expect(after.started).toBe(true);
  });

  it("refuses a turn already cancelled, and ignores a cancel after it started", async () => {
    const scheduler = new TurnScheduler(limits);
    const controller = new AbortController();
    controller.abort();
    const refused = ask(scheduler, "a", "cli", "a-1", { signal: controller.signal });
    const later = new AbortController();
    const started = ask(scheduler, "a", "cli", "a-2", { signal: later.signal });
    await settle();
    later.abort();
    await settle();
    expect(refused.failed?.name).toBe("AbortError");
    expect(started.started).toBe(true);
    expect(scheduler.stats().running.cli).toBe(1);
  });

  it("gets its slot back from a turn that threw, once however often it is released", async () => {
    const scheduler = new TurnScheduler({ cliPerUser: 1, cliTotal: 1, nativeTotal: 1 });
    const run = async () => {
      const release = await scheduler.acquire({ ownerId: "a", kind: "cli", threadId: "a-1" });
      try {
        throw new Error("the CLI would not start");
      } finally {
        release();
        release();
      }
    };
    await expect(run()).rejects.toThrow("would not start");
    const next = ask(scheduler, "a", "cli", "a-2");
    const third = ask(scheduler, "b", "cli", "b-1");
    await settle();
    expect(next.started).toBe(true);
    expect(third.started).toBe(false);
  });

  it("caps OMP turns server-wide, apart from CLI turns and with no per-account limit", async () => {
    const scheduler = new TurnScheduler({ cliPerUser: 1, cliTotal: 1, nativeTotal: 1, ompTotal: 2 });
    const cli = ask(scheduler, "a", "cli", "a-cli");
    const first = ask(scheduler, "a", "omp", "a-1");
    const second = ask(scheduler, "a", "omp", "a-2");
    const third = ask(scheduler, "b", "omp", "b-1");
    await settle();
    expect([cli.started, first.started, second.started, third.started]).toEqual([true, true, true, false]);
    expect(third.aheads).toEqual([0]);
    expect(scheduler.stats()).toEqual({ running: { cli: 1, native: 0, omp: 2 }, waiting: { cli: 0, native: 0, omp: 1 } });
    first.release();
    await settle();
    expect(third.started).toBe(true);
  });

  it("leases an OMP slot to a bridge call, which waits only so long for one", async () => {
    const scheduler = new TurnScheduler({ ...limits, ompTotal: 1 });
    const first = await scheduler.lease({ ownerId: "a", threadId: "a-1", waitMs: 1000 });
    expect(first).toBeTypeOf("function");
    expect(scheduler.stats().running.omp).toBe(1);

    const started = Date.now();
    const second = await scheduler.lease({ ownerId: "b", threadId: "b-1", waitMs: 50 });
    expect(second).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    // Its place is given up, not left in the queue.
    expect(scheduler.stats().waiting.omp).toBe(0);

    const third = scheduler.lease({ ownerId: "b", threadId: "b-2", waitMs: 1000 });
    first!();
    expect(await third).toBeTypeOf("function");
  });

  it("counts a bridge call's lease against OMP turns, and gives one up when its bridge goes", async () => {
    const scheduler = new TurnScheduler({ ...limits, ompTotal: 1 });
    const lease = await scheduler.lease({ ownerId: "a", threadId: "a-1", waitMs: 1000 });
    const turn = ask(scheduler, "b", "omp", "b-turn");
    await settle();
    expect(turn.started).toBe(false);
    lease!();
    await settle();
    expect(turn.started).toBe(true);

    const gone = new AbortController();
    const waiting = scheduler.lease({ ownerId: "a", threadId: "a-2", waitMs: 10_000, signal: gone.signal });
    gone.abort();
    expect(await waiting).toBeNull();
    expect(scheduler.stats().waiting.omp).toBe(0);
  });

  it("leaves OMP turns unlimited without a cap", async () => {
    const scheduler = new TurnScheduler(limits);
    const turns = Array.from({ length: 5 }, (_, i) => ask(scheduler, "a", "omp", `a-${i}`));
    await settle();
    expect(turns.every((turn) => turn.started)).toBe(true);
  });
});

describe("shared memory admission", () => {
  const memory = { budgetMb: 1024, estimatesMb: { cli: 512, omp: 512, native: 128 } };
  it("shares reservations across providers and releases exactly once", async () => {
    const scheduler = new TurnScheduler({ ...limits, ompTotal: 6, memory });
    const a = await scheduler.acquire({ ownerId: "a", threadId: "a", kind: "cli" });
    const b = await scheduler.acquire({ ownerId: "b", threadId: "b", kind: "omp" });
    const c = ask(scheduler, "c", "native", "c");
    await settle();
    expect(c.started).toBe(false);
    expect(scheduler.reservedMemoryMb()).toBe(1024);
    a(); a();
    await settle();
    expect(c.started).toBe(true);
    expect(scheduler.reservedMemoryMb()).toBe(640);
    b(); c.release();
    expect(scheduler.reservedMemoryMb()).toBe(0);
  });
  it("rejects an impossible request without retaining it", async () => {
    const scheduler = new TurnScheduler({ ...limits, memory: { ...memory, budgetMb: 100 } });
    await expect(scheduler.acquire({ ownerId: "a", threadId: "a", kind: "cli" })).rejects.toThrow("exceeds");
    expect(scheduler.stats().waiting.cli).toBe(0);
  });
  it("bounds waiting work and frees cancelled queue positions", async () => {
    const scheduler = new TurnScheduler({ ...limits, cliTotal: 1, maxWaiting: 1 });
    const release = await scheduler.acquire({ ownerId: "a", threadId: "a", kind: "cli" });
    const controller = new AbortController();
    const queued = ask(scheduler, "b", "cli", "b", { signal: controller.signal });
    await expect(scheduler.acquire({ ownerId: "c", threadId: "c", kind: "cli" })).rejects.toThrow("queue is full");
    controller.abort();
    await settle();
    expect(queued.failed?.name).toBe("AbortError");
    expect(scheduler.stats().waiting.cli).toBe(0);
    release();
  });
  it("expires waiting requests without leaking reservations", async () => {
    const scheduler = new TurnScheduler({ ...limits, cliTotal: 1, waitTimeoutMs: 10 });
    const release = await scheduler.acquire({ ownerId: "a", threadId: "a", kind: "cli" });
    const queued = ask(scheduler, "b", "cli", "b");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(queued.failed?.message).toContain("Timed out");
    expect(scheduler.stats().waiting.cli).toBe(0);
    release();
  });
});

describe("memory pressure admission", () => {
  const GB = 1024 ** 3;
  const estimatesMb = { cli: 512, omp: 512, native: 128 };
  /** A scheduler whose readings and clock the test sets. */
  function pressured(extra: Partial<Parameters<TurnScheduler["setMemoryPressure"]>[0] & object> = {}) {
    const state = { now: 1_000_000, reading: { usedBytes: 1 * GB, limitBytes: 10 * GB, at: 1_000_000 } as { usedBytes: number; limitBytes: number; at: number } | null };
    const scheduler = new TurnScheduler({ cliPerUser: 10, cliTotal: 10, nativeTotal: 10, ompTotal: 10 });
    scheduler.setMemoryPressure({
      read: () => state.reading, pauseRatio: 0.8, resumeRatio: 0.7, staleMs: 60_000, estimatesMb, now: () => state.now, ...extra,
    });
    /** A fresh reading at the current time. */
    const sample = (usedGb: number) => {
      state.reading = { usedBytes: usedGb * GB, limitBytes: 10 * GB, at: state.now };
      scheduler.recheck();
    };
    return { scheduler, state, sample };
  }

  it("holds new starts at the pause line and resumes only below the resume line", async () => {
    const { scheduler, state, sample } = pressured();
    state.reading!.usedBytes = 8.5 * GB;
    const turn = ask(scheduler, "a", "native", "t");
    await settle();
    expect(turn.started).toBe(false);
    expect(scheduler.pressurePaused).toBe(true);
    sample(7.5); // under the pause line, above the resume one: still paused
    await settle();
    expect(turn.started).toBe(false);
    sample(6.5);
    await settle();
    expect(turn.started).toBe(true);
    expect(scheduler.pressurePaused).toBe(false);
  });

  it("counts turns started since the last reading on top of it", async () => {
    const { scheduler, state } = pressured({ settleMs: 30_000 });
    state.reading!.usedBytes = 6 * GB;
    // 6 GB + 512 MB each: three fit under 8 GB, the fourth would cross it.
    const turns = Array.from({ length: 4 }, (_, i) => ask(scheduler, `u${i}`, "cli", `t${i}`));
    await settle();
    expect(turns.filter((t) => t.started)).toHaveLength(3);
    // A reading long after those starts carries them; they stop counting twice.
    state.now += 31_000;
    state.reading = { usedBytes: 6 * GB, limitBytes: 10 * GB, at: state.now };
    scheduler.recheck();
    await settle();
    expect(turns[3]!.started).toBe(true);
  });

  it("holds starts back on a stale or missing reading", async () => {
    const { scheduler, state, sample } = pressured();
    state.now += 61_000;
    const turn = ask(scheduler, "a", "native", "t");
    await settle();
    expect(turn.started).toBe(false);
    state.reading = null;
    scheduler.recheck();
    await settle();
    expect(turn.started).toBe(false);
    sample(1);
    await settle();
    expect(turn.started).toBe(true);
  });

  it("lets running turns finish and keeps count limits", async () => {
    const { scheduler, state } = pressured();
    const running = await scheduler.acquire({ ownerId: "a", threadId: "a", kind: "cli" });
    state.reading!.usedBytes = 9 * GB;
    const queued = ask(scheduler, "b", "cli", "b");
    await settle();
    expect(queued.started).toBe(false);
    running(); // releasing does not let the queued one past the pressure
    await settle();
    expect(queued.started).toBe(false);
    expect(scheduler.stats().running.cli).toBe(0);
  });

  it("is off again with null, and rejects inverted ratios", async () => {
    const { scheduler, state } = pressured();
    state.reading = null;
    const turn = ask(scheduler, "a", "native", "t");
    await settle();
    expect(turn.started).toBe(false);
    scheduler.setMemoryPressure(null);
    await settle();
    expect(turn.started).toBe(true);
    expect(() => scheduler.setMemoryPressure({ read: () => null, pauseRatio: 0.7, resumeRatio: 0.8, staleMs: 1, estimatesMb })).toThrow(/ratios/);
  });
});
