import { describe, expect, it } from "vitest";
import { DrainableWorker, KeyedWorker } from "./worker.js";

const tick = () => new Promise((r) => setImmediate(r));

describe("DrainableWorker", () => {
  it("drains only after every handler has settled", async () => {
    const done: number[] = [];
    const w = new DrainableWorker<number>("test", async (n) => {
      await new Promise((r) => setTimeout(r, 5));
      done.push(n);
    });

    w.push(1);
    w.push(2);
    w.push(3);
    expect(w.outstanding).toBeGreaterThan(0);

    await w.drain();
    expect(done).toEqual([1, 2, 3]);
    expect(w.outstanding).toBe(0);
  });

  it("serializes handlers rather than interleaving them", async () => {
    const order: string[] = [];
    const w = new DrainableWorker<number>("test", async (n) => {
      order.push(`start-${n}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end-${n}`);
    });

    w.push(1);
    w.push(2);
    await w.drain();

    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("reports handler failures without stalling the queue", async () => {
    const errors: unknown[] = [];
    const done: number[] = [];
    const w = new DrainableWorker<number>(
      "test",
      async (n) => {
        if (n === 2) throw new Error("boom");
        done.push(n);
      },
      (e) => errors.push(e),
    );

    w.push(1);
    w.push(2);
    w.push(3);
    await w.drain();

    expect(done).toEqual([1, 3]);
    expect(errors).toHaveLength(1);
  });

  it("drain() on an empty worker resolves immediately", async () => {
    const w = new DrainableWorker<number>("test", async () => {});
    await expect(w.drain()).resolves.toBeUndefined();
  });

  it("refuses work after stop()", async () => {
    const w = new DrainableWorker<number>("test", async () => {});
    await w.stop();
    expect(() => w.push(1)).toThrow(/stopped/);
  });

  it("handles work pushed from inside a handler", async () => {
    const seen: number[] = [];
    const w: DrainableWorker<number> = new DrainableWorker<number>("test", async (n) => {
      seen.push(n);
      if (n < 3) w.push(n + 1);
    });

    w.push(1);
    await w.drain();
    await tick();
    expect(seen).toEqual([1, 2, 3]);
  });
});

describe("KeyedWorker", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("runs one key's items in order, one at a time", async () => {
    const order: string[] = [];
    const w = new KeyedWorker<number>("test", 8, async (n) => {
      order.push(`start-${n}`);
      await sleep(5);
      order.push(`end-${n}`);
    });
    w.push("a", 1);
    w.push("a", 2);
    w.push("a", 3);
    await w.drain();
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  it("runs different keys side by side", async () => {
    const order: string[] = [];
    const w = new KeyedWorker<string>("test", 8, async (key) => {
      order.push(`start-${key}`);
      await sleep(10);
      order.push(`end-${key}`);
    });
    w.push("a", "a");
    w.push("b", "b");
    await w.drain();
    expect(order.slice(0, 2).sort()).toEqual(["start-a", "start-b"]);
  });

  it("never runs more than maxParallel at once, and lets the waiting ones through in order", async () => {
    let running = 0;
    let most = 0;
    const started: number[] = [];
    const w = new KeyedWorker<number>("test", 3, async (n) => {
      started.push(n);
      running++;
      most = Math.max(most, running);
      await sleep(5);
      running--;
    });
    for (let n = 0; n < 12; n++) w.push(`k${n}`, n);
    expect(w.active).toBe(3);
    await w.drain();
    expect(most).toBe(3);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(w.active).toBe(0);
  });

  it("drains only when every key is done, and forgets idle keys", async () => {
    const done: string[] = [];
    const w = new KeyedWorker<string>("test", 8, async (item) => {
      await sleep(item.startsWith("slow") ? 20 : 1);
      done.push(item);
    });
    w.push("a", "fast");
    w.push("b", "slow");
    expect(w.outstanding).toBe(2);
    expect(w.keys).toBe(2);
    await w.drain();
    expect(done.sort()).toEqual(["fast", "slow"]);
    expect(w.outstanding).toBe(0);
    expect(w.keys).toBe(0);
  });

  it("reports a failure without holding up its key or the permit", async () => {
    const errors: unknown[] = [];
    const done: number[] = [];
    const w = new KeyedWorker<number>(
      "test",
      1,
      async (n) => {
        if (n === 1) throw new Error("boom");
        done.push(n);
      },
      (error) => errors.push(error),
    );
    w.push("a", 1);
    w.push("a", 2);
    w.push("b", 3);
    await w.drain();
    expect(done.sort()).toEqual([2, 3]);
    expect(errors).toHaveLength(1);
    expect(w.active).toBe(0);
  });

  it("refuses work once stopped, after finishing what it had", async () => {
    const done: number[] = [];
    const w = new KeyedWorker<number>("test", 2, async (n) => {
      await sleep(5);
      done.push(n);
    });
    w.push("a", 1);
    await w.stop();
    expect(done).toEqual([1]);
    expect(() => w.push("a", 2)).toThrow(/stopped/);
  });
});
