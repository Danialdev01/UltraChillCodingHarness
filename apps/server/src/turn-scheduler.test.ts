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
    expect(scheduler.stats()).toEqual({ running: { cli: 3, native: 0 }, waiting: { cli: 1, native: 0 } });
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
});
