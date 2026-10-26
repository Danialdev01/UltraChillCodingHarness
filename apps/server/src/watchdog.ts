import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Histogram } from "./metrics.js";
import type { CgroupSample } from "./resource-sampler.js";

/**
 * Tells somebody when the server is in trouble, without a monitoring stack.
 *
 * Every 15 s it reads the figures `/metrics` already has and checks four
 * conditions. One that has held long enough logs at error and, with
 * `ALERT_WEBHOOK_URL` set, POSTs JSON there (ntfy or a Slack-compatible
 * hook: the message is `text`). Each condition alerts at most once per
 * 15 min, however long it lasts.
 */

/** What the watchdog reads on each check. A null figure is one it could not get. */
export interface Readings {
  /** The cgroup's `memory.current` and `memory.max`; null without a limit. */
  memory: { current: number; max: number } | null;
  /** The cgroup's `oom_kill` count since it was created. */
  oomKills: number | null;
  /** Event-loop delay p99 since the last check. */
  eventLoopP99Ms: number;
  /** Engine queue wait p99 over the commands since the last check; 0 with none. */
  engineWaitP99Ms: number;
}

export type AlertName = "memory" | "event_loop" | "oom_kill" | "engine_wait";

export interface Alert {
  alert: AlertName;
  /** One line for a person: what happened and the figure. */
  text: string;
  value: number;
  threshold: number;
  at: string;
}

interface Condition {
  name: AlertName;
  /** How long it must hold before it alerts. */
  forMs: number;
  threshold: number;
  /** The figure compared with the threshold, or null when there is none this time. */
  value(readings: Readings, previous: Readings | null): number | null;
  text(value: number): string;
}

const MINUTE = 60_000;

const CONDITIONS: readonly Condition[] = [
  {
    name: "memory",
    forMs: 2 * MINUTE,
    threshold: 0.85,
    value: ({ memory }) => (memory && memory.max > 0 ? memory.current / memory.max : null),
    text: (share) => `The container has used ${Math.round(share * 100)}% of its memory limit for 2 minutes.`,
  },
  {
    name: "event_loop",
    forMs: MINUTE,
    threshold: 200,
    value: (readings) => readings.eventLoopP99Ms,
    text: (ms) => `The server's event loop has lagged (p99 ${Math.round(ms)} ms) for a minute.`,
  },
  {
    name: "oom_kill",
    forMs: 0,
    // Any increase: the value is the number of new kills.
    threshold: 0,
    value: (readings, previous) =>
      readings.oomKills === null || previous?.oomKills == null ? null : readings.oomKills - previous.oomKills,
    text: (kills) => `The kernel killed ${kills} ${kills === 1 ? "process" : "processes"} in the container for memory.`,
  },
  {
    name: "engine_wait",
    forMs: MINUTE,
    threshold: 500,
    value: (readings) => readings.engineWaitP99Ms,
    text: (ms) => `Commands have waited in the engine queue (p99 ${Math.round(ms)} ms) for a minute.`,
  },
];

/** At most one alert per condition this often. */
export const ALERT_EVERY_MS = 15 * MINUTE;
const CHECK_EVERY_MS = 15_000;

export interface WatchdogOptions {
  read: () => Readings;
  log: { error: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void };
  webhookUrl?: string;
  fetch?: typeof fetch;
  intervalMs?: number;
}

export class Watchdog {
  readonly #options: WatchdogOptions;
  /** When each condition started holding, while it does. */
  readonly #since = new Map<AlertName, number>();
  readonly #lastAlert = new Map<AlertName, number>();
  #previous: Readings | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: WatchdogOptions) {
    this.#options = options;
  }

  start(): void {
    this.#timer = setInterval(() => void this.check(this.#options.read()), this.#options.intervalMs ?? CHECK_EVERY_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Checks one set of readings; returns the alerts it sent. */
  async check(readings: Readings, now = Date.now()): Promise<Alert[]> {
    const fired: Alert[] = [];
    for (const condition of CONDITIONS) {
      const value = condition.value(readings, this.#previous);
      if (value === null || value <= condition.threshold) {
        this.#since.delete(condition.name);
        continue;
      }
      const since = this.#since.get(condition.name) ?? now;
      this.#since.set(condition.name, since);
      if (now - since < condition.forMs) continue;
      const last = this.#lastAlert.get(condition.name);
      if (last !== undefined && now - last < ALERT_EVERY_MS) continue;
      this.#lastAlert.set(condition.name, now);
      fired.push({
        alert: condition.name,
        text: condition.text(value),
        value,
        threshold: condition.threshold,
        at: new Date(now).toISOString(),
      });
    }
    this.#previous = readings;
    await Promise.all(fired.map((alert) => this.#send(alert)));
    return fired;
  }

  async #send(alert: Alert): Promise<void> {
    this.#options.log.error(alert, "alert");
    const url = this.#options.webhookUrl;
    if (!url) return;
    try {
      const response = await (this.#options.fetch ?? fetch)(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) this.#options.log.warn({ alert: alert.alert, status: response.status }, "alert webhook refused");
    } catch (error) {
      this.#options.log.warn({ alert: alert.alert, err: error }, "could not reach the alert webhook");
    }
  }
}

/**
 * The quantile `q` of what a histogram observed between two snapshots, as
 * the upper bound of the bucket it falls in, in ms; 0 with nothing observed.
 * Past the last bucket it reads as the last bound.
 */
export function windowQuantileMs(
  buckets: readonly number[],
  before: readonly number[],
  after: readonly number[],
  q: number,
): number {
  const counts = after.map((n, i) => n - (before[i] ?? 0));
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total <= 0) return 0;
  const rank = Math.ceil(total * q);
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i]!;
    if (seen >= rank) return (buckets[Math.min(i, buckets.length - 1)] ?? 0) * 1000;
  }
  return (buckets[buckets.length - 1] ?? 0) * 1000;
}

/**
 * The server's readings: the sampler's last cgroup figures, an event-loop
 * monitor reset on every read, and the engine's wait histogram since the
 * last read.
 */
export function serverReadings(cgroup: () => CgroupSample | null, engineWait: Histogram): () => Readings {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let waits = engineWait.totals();
  return () => {
    const sample = cgroup();
    const eventLoopP99Ms = loop.count > 0 ? loop.percentile(99) / 1e6 : 0;
    loop.reset();
    const now = engineWait.totals();
    const engineWaitP99Ms = windowQuantileMs(engineWait.buckets, waits, now, 0.99);
    waits = now;
    return {
      memory: sample?.current != null && sample.max != null ? { current: sample.current, max: sample.max } : null,
      oomKills: sample?.events.get("oom_kill") ?? null,
      eventLoopP99Ms,
      engineWaitP99Ms,
    };
  };
}
