import { describe, expect, it } from "vitest";
import { DrainableWorker } from "./worker.js";

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
