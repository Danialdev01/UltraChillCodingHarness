import { describe, expect, it, vi } from "vitest";
import { LATENCY_BUCKETS, Registry } from "./metrics.js";
import { ALERT_EVERY_MS, serverReadings, Watchdog, windowQuantileMs, type Readings } from "./watchdog.js";

const GB = 2 ** 30;
const calm: Readings = { memory: { current: 2 * GB, max: 7 * GB }, oomKills: 0, eventLoopP99Ms: 12, engineWaitP99Ms: 1 };
const STEP = 15_000;

function watchdog(webhook?: { status?: number; fail?: boolean }) {
  const errors: object[] = [];
  const warnings: object[] = [];
  const posted: unknown[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (webhook?.fail) throw new Error("connection refused");
    posted.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: webhook?.status ?? 200 });
  });
  const dog = new Watchdog({
    read: () => calm,
    log: { error: (obj) => errors.push(obj), warn: (obj) => warnings.push(obj) },
    webhookUrl: webhook ? "https://ntfy.example/ucch" : undefined,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  /** Checks `readings` every 15 s from `from` for `forMs`; the names alerted, in order. */
  async function run(readings: Readings, from: number, forMs: number): Promise<string[]> {
    const names: string[] = [];
    for (let t = from; t <= from + forMs; t += STEP) {
      for (const alert of await dog.check(readings, t)) names.push(alert.alert);
    }
    return names;
  }
  return { dog, run, errors, warnings, posted, fetch };
}

describe("Watchdog", () => {
  it("is quiet while everything is calm", async () => {
    const { run, errors } = watchdog();
    expect(await run(calm, 0, 30 * 60_000)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("alerts on memory above 85% of the limit once it has held for 2 minutes", async () => {
    const { run } = watchdog();
    const high = { ...calm, memory: { current: 6.2 * GB, max: 7 * GB } };
    expect(await run(high, 0, 2 * 60_000 - STEP)).toEqual([]);
    expect(await run(high, 2 * 60_000, 0)).toEqual(["memory"]);
  });

  it("starts the 2 minutes again when memory drops in between", async () => {
    const { dog, run } = watchdog();
    const high = { ...calm, memory: { current: 6.2 * GB, max: 7 * GB } };
    expect(await run(high, 0, 90_000)).toEqual([]);
    await dog.check(calm, 105_000);
    expect(await run(high, 120_000, 2 * 60_000 - STEP)).toEqual([]);
    expect(await run(high, 240_000, 0)).toEqual(["memory"]);
  });

  it("ignores memory without a limit", async () => {
    const { run } = watchdog();
    expect(await run({ ...calm, memory: null }, 0, 10 * 60_000)).toEqual([]);
  });

  it("alerts on an event loop lagging over 200 ms p99 for a minute", async () => {
    const { run } = watchdog();
    const lagging = { ...calm, eventLoopP99Ms: 350 };
    expect(await run(lagging, 0, 60_000 - STEP)).toEqual([]);
    expect(await run(lagging, 60_000, 0)).toEqual(["event_loop"]);
  });

  it("alerts on engine waits over 500 ms p99 for a minute", async () => {
    const { run } = watchdog();
    const backedUp = { ...calm, engineWaitP99Ms: 1000 };
    expect(await run(backedUp, 0, 60_000 - STEP)).toEqual([]);
    expect(await run(backedUp, 60_000, 0)).toEqual(["engine_wait"]);
  });

  it("alerts at once when the OOM kill count goes up, not on the count it started with", async () => {
    const { dog, errors } = watchdog();
    expect(await dog.check({ ...calm, oomKills: 3 }, 0)).toEqual([]);
    const [alert] = await dog.check({ ...calm, oomKills: 4 }, STEP);
    expect(alert).toMatchObject({ alert: "oom_kill", value: 1, text: "The kernel killed 1 process in the container for memory." });
    expect(errors).toHaveLength(1);
  });

  it("alerts once per condition per 15 minutes, however long it lasts", async () => {
    const { run } = watchdog();
    const lagging = { ...calm, eventLoopP99Ms: 350 };
    // From the first alert at 1 min, the next comes 15 min later.
    expect(await run(lagging, 0, 60_000 + ALERT_EVERY_MS - STEP)).toEqual(["event_loop"]);
    expect(await run(lagging, 60_000 + ALERT_EVERY_MS, 0)).toEqual(["event_loop"]);
  });

  it("rate-limits a repeated OOM kill too", async () => {
    const { dog } = watchdog();
    await dog.check(calm, 0);
    expect((await dog.check({ ...calm, oomKills: 1 }, STEP)).map((a) => a.alert)).toEqual(["oom_kill"]);
    expect(await dog.check({ ...calm, oomKills: 2 }, 2 * STEP)).toEqual([]);
    expect((await dog.check({ ...calm, oomKills: 3 }, STEP + ALERT_EVERY_MS)).map((a) => a.alert)).toEqual(["oom_kill"]);
  });

  it("keeps each condition's limit to itself", async () => {
    const { run } = watchdog();
    const both = { ...calm, eventLoopP99Ms: 350, engineWaitP99Ms: 1000 };
    expect(await run(both, 0, 60_000)).toEqual(["event_loop", "engine_wait"]);
  });

  it("logs every alert at error and POSTs it as JSON with the message in `text`", async () => {
    const { dog, errors, posted, fetch } = watchdog({});
    await dog.check(calm, 0);
    await dog.check({ ...calm, oomKills: 2 }, STEP);
    expect(fetch).toHaveBeenCalledWith("https://ntfy.example/ucch", expect.objectContaining({ method: "POST" }));
    expect(posted).toEqual([
      {
        alert: "oom_kill",
        text: "The kernel killed 2 processes in the container for memory.",
        value: 2,
        threshold: 0,
        at: new Date(STEP).toISOString(),
      },
    ]);
    expect(errors).toEqual(posted);
  });

  it("logs a webhook that refuses or cannot be reached, and carries on", async () => {
    for (const webhook of [{ status: 500 }, { fail: true }]) {
      const { dog, warnings, errors } = watchdog(webhook);
      await dog.check(calm, 0);
      await expect(dog.check({ ...calm, oomKills: 1 }, STEP)).resolves.toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(warnings).toHaveLength(1);
    }
  });
});

describe("windowQuantileMs", () => {
  const buckets = [0.001, 0.01, 0.1, 1];

  it("reads the bucket the quantile falls in, between two snapshots", () => {
    // 98 fast, then 2 slow: p99 is in the 1 s bucket.
    expect(windowQuantileMs(buckets, [0, 0, 0, 0, 0], [98, 0, 0, 2, 0], 0.99)).toBe(1000);
    // Earlier observations do not count.
    expect(windowQuantileMs(buckets, [0, 0, 0, 50, 0], [100, 0, 0, 50, 0], 0.99)).toBe(1);
  });

  it("is 0 with nothing observed, and the last bound past the last bucket", () => {
    expect(windowQuantileMs(buckets, [1, 2, 3, 4, 5], [1, 2, 3, 4, 5], 0.99)).toBe(0);
    expect(windowQuantileMs(buckets, [0, 0, 0, 0, 0], [0, 0, 0, 0, 3], 0.99)).toBe(1000);
  });
});

describe("serverReadings", () => {
  it("reads the cgroup's last sample and the engine's waits since the last read", () => {
    const histogram = new Registry().histogram("engine_wait_seconds", "", LATENCY_BUCKETS, ["command"]);
    histogram.observe({ command: "thread.send" }, 5);
    const read = serverReadings(
      () => ({ current: 3 * GB, max: 7 * GB, stat: new Map(), events: new Map([["oom_kill", 2]]), swap: 0 }),
      histogram,
    );
    // The 5 s wait came before the first read.
    expect(read()).toMatchObject({ memory: { current: 3 * GB, max: 7 * GB }, oomKills: 2, engineWaitP99Ms: 0 });
    histogram.observe({ command: "thread.send" }, 0.7);
    histogram.observe({ command: "terminal.create" }, 0.002);
    expect(read().engineWaitP99Ms).toBe(1000);
    expect(read().engineWaitP99Ms).toBe(0);
  });

  it("has no memory figure without a limit or before the first sample", () => {
    const histogram = new Registry().histogram("engine_wait_seconds", "", LATENCY_BUCKETS, ["command"]);
    expect(serverReadings(() => null, histogram)()).toMatchObject({ memory: null, oomKills: null });
    expect(
      serverReadings(() => ({ current: GB, max: null, stat: new Map(), events: new Map(), swap: null }), histogram)().memory,
    ).toBeNull();
  });
});
