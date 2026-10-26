import { createHash, timingSafeEqual } from "node:crypto";
import {
  constants as perfConstants,
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
  type IntervalHistogram,
} from "node:perf_hooks";

/**
 * The server's own numbers, in the Prometheus text format, at `/metrics`.
 *
 * Hand-rolled rather than a client library: three metric kinds, fixed
 * buckets and a text renderer are a hundred lines, and a dependency would be
 * more code than that to audit. Nothing here allocates per observation
 * beyond the label key, so the hot paths that count -- every WebSocket frame
 * out, every engine command -- pay a map lookup and an addition.
 *
 * A family is identified by its name. Asking the registry for a name it
 * already holds returns that family, so a module can declare its metrics at
 * load time without caring who else declared them first; asking for the same
 * name as a different kind is a programming error and throws.
 */

type Labels = Readonly<Record<string, string>>;

/** Seconds, from a millisecond up: request handling, queue waits, renders. */
export const LATENCY_BUCKETS: readonly number[] = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** Garbage-collection pauses sit well below request latencies. */
const GC_BUCKETS: readonly number[] = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1];

abstract class Family {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[],
  ) {}

  abstract readonly type: "counter" | "gauge" | "histogram";
  abstract lines(): string[];

  /** One series per distinct label set, keyed by the values in declared order. */
  protected key(labels: Labels | undefined): string {
    if (this.labelNames.length === 0) return "";
    return this.labelNames.map((name) => labels?.[name] ?? "").join("\u0001");
  }

  protected labelText(key: string, extra?: string): string {
    const parts: string[] = [];
    if (this.labelNames.length > 0) {
      const values = key.split("\u0001");
      this.labelNames.forEach((name, i) => parts.push(`${name}="${escapeLabel(values[i] ?? "")}"`));
    }
    if (extra) parts.push(extra);
    return parts.length > 0 ? `{${parts.join(",")}}` : "";
  }
}

export class Counter extends Family {
  readonly type = "counter" as const;
  #values = new Map<string, number>();

  inc(labels?: Labels, by = 1): void {
    const key = this.key(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + by);
  }

  lines(): string[] {
    return [...this.#values].map(([key, value]) => `${this.name}${this.labelText(key)} ${formatNumber(value)}`);
  }
}

export class Gauge extends Family {
  readonly type = "gauge" as const;
  #values = new Map<string, number>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    /** Run before each render, to read the value from wherever it lives. */
    readonly collect?: (gauge: Gauge) => void | Promise<void>,
  ) {
    super(name, help, labelNames);
  }

  set(labels: Labels | undefined, value: number): void {
    this.#values.set(this.key(labels), value);
  }

  /** Forgets every series: for a collector whose label sets come and go. */
  reset(): void {
    this.#values.clear();
  }

  lines(): string[] {
    return [...this.#values].map(([key, value]) => `${this.name}${this.labelText(key)} ${formatNumber(value)}`);
  }
}

export class Histogram extends Family {
  readonly type = "histogram" as const;
  readonly buckets: readonly number[];
  #series = new Map<string, { counts: number[]; sum: number; count: number }>();

  constructor(name: string, help: string, buckets: readonly number[], labelNames: readonly string[]) {
    super(name, help, labelNames);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels | undefined, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = this.key(labels);
    let series = this.#series.get(key);
    if (!series) {
      series = { counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.#series.set(key, series);
    }
    // Stored per bucket and summed when rendered, so an observation is one
    // increment rather than one per bucket above it.
    const index = this.buckets.findIndex((bound) => value <= bound);
    if (index >= 0) series.counts[index]!++;
    series.sum += value;
    series.count++;
  }

  /**
   * Observations per bucket across every label set, not cumulative, with
   * the last entry past the highest bound: for a reader that compares two
   * snapshots (watchdog.ts).
   */
  totals(): number[] {
    const totals = new Array<number>(this.buckets.length + 1).fill(0);
    for (const series of this.#series.values()) {
      let inBuckets = 0;
      series.counts.forEach((n, i) => {
        totals[i]! += n;
        inBuckets += n;
      });
      totals[this.buckets.length]! += series.count - inBuckets;
    }
    return totals;
  }

  lines(): string[] {
    const out: string[] = [];
    for (const [key, series] of this.#series) {
      let cumulative = 0;
      this.buckets.forEach((bound, i) => {
        cumulative += series.counts[i]!;
        out.push(`${this.name}_bucket${this.labelText(key, `le="${formatNumber(bound)}"`)} ${cumulative}`);
      });
      out.push(`${this.name}_bucket${this.labelText(key, 'le="+Inf"')} ${series.count}`);
      out.push(`${this.name}_sum${this.labelText(key)} ${formatNumber(series.sum)}`);
      out.push(`${this.name}_count${this.labelText(key)} ${series.count}`);
    }
    return out;
  }
}

export class Registry {
  #families = new Map<string, Family>();

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.#register(name, "counter", () => new Counter(name, help, labelNames));
  }

  gauge(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    collect?: (gauge: Gauge) => void | Promise<void>,
  ): Gauge {
    return this.#register(name, "gauge", () => new Gauge(name, help, labelNames, collect));
  }

  histogram(
    name: string,
    help: string,
    buckets: readonly number[] = LATENCY_BUCKETS,
    labelNames: readonly string[] = [],
  ): Histogram {
    return this.#register(name, "histogram", () => new Histogram(name, help, buckets, labelNames));
  }

  /**
   * Every family as Prometheus text. Collectors run first, together; one that
   * throws leaves its gauge as it was rather than failing the scrape.
   */
  async render(): Promise<string> {
    const families = [...this.#families.values()];
    await Promise.all(
      families.map(async (family) => {
        if (!(family instanceof Gauge) || !family.collect) return;
        try {
          await family.collect(family);
        } catch {
          // A scrape that fails because one source is down tells nobody
          // anything about the others.
        }
      }),
    );
    const out: string[] = [];
    for (const family of families) {
      out.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
      out.push(`# TYPE ${family.name} ${family.type}`);
      out.push(...family.lines());
    }
    return `${out.join("\n")}\n`;
  }

  #register<T extends Family>(name: string, type: Family["type"], create: () => T): T {
    const existing = this.#families.get(name);
    if (existing) {
      if (existing.type !== type) throw new Error(`metric ${name} is already a ${existing.type}`);
      return existing as T;
    }
    const family = create();
    this.#families.set(name, family);
    return family;
  }
}

/** The process's registry: what `/metrics` renders. */
export const registry = new Registry();

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "+Inf";
  if (value === -Infinity) return "-Inf";
  return String(value);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Whether a socket's peer address is this machine's loopback. */
export function isLoopback(address: string | undefined): boolean {
  return LOOPBACK.has(address ?? "");
}

/**
 * Whether a request may read `/metrics`.
 *
 * With a token configured, only a matching bearer token: the digests are
 * compared rather than the strings, so the comparison is constant-time and
 * never throws on a length mismatch. Without one, only loopback, judged by
 * the socket's own address -- never `request.ip`, which trusting the proxy
 * lets a header rewrite. Traefik reaches the container over the Docker
 * network, so nothing from outside ever presents a loopback address.
 */
export function metricsAccess(input: {
  authorization: string | undefined;
  remoteAddress: string | undefined;
  token: string | undefined;
}): boolean {
  if (input.token) {
    if (!input.authorization) return false;
    const given = createHash("sha256").update(input.authorization).digest();
    const expected = createHash("sha256").update(`Bearer ${input.token}`).digest();
    return timingSafeEqual(given, expected);
  }
  return isLoopback(input.remoteAddress);
}

const GC_KINDS: Record<number, string> = {
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

/**
 * The runtime's own health: event-loop delay and utilisation, memory, and
 * garbage-collection pauses. Returns the function that stops it.
 *
 * Event-loop delay is reported twice. The `scrape` window is reset on every
 * render, so it answers "since the last scrape"; the `60s` window is a
 * second monitor reset once a minute, so a reader without a scraper -- a
 * curl during an incident -- still gets a meaningful recent figure.
 */
export function startRuntimeMetrics(target: Registry = registry): () => void {
  const perScrape = monitorEventLoopDelay({ resolution: 10 });
  const perMinute = monitorEventLoopDelay({ resolution: 10 });
  perScrape.enable();
  perMinute.enable();
  let lastMinute: { p50: number; p99: number; max: number } | null = null;
  const minuteTimer = setInterval(() => {
    lastMinute = delayStats(perMinute);
    perMinute.reset();
  }, 60_000);
  minuteTimer.unref();

  target.gauge(
    "event_loop_delay_seconds",
    "Event-loop delay; quantile 1 is the maximum",
    ["window", "quantile"],
    (gauge) => {
      const scrape = delayStats(perScrape);
      perScrape.reset();
      const minute = lastMinute ?? delayStats(perMinute);
      for (const [window, stats] of [["scrape", scrape], ["60s", minute]] as const) {
        gauge.set({ window, quantile: "0.5" }, stats.p50);
        gauge.set({ window, quantile: "0.99" }, stats.p99);
        gauge.set({ window, quantile: "1" }, stats.max);
      }
    },
  );

  let elu = performance.eventLoopUtilization();
  target.gauge("event_loop_utilization", "Share of time the event loop was busy since the last scrape", [], (gauge) => {
    const now = performance.eventLoopUtilization();
    gauge.set(undefined, performance.eventLoopUtilization(now, elu).utilization);
    elu = now;
  });

  target.gauge("process_rss_bytes", "Resident set size of this process", [], (gauge) => {
    gauge.set(undefined, process.memoryUsage.rss());
  });
  target.gauge("process_heap_bytes", "V8 heap and off-heap memory of this process", ["type"], (gauge) => {
    const memory = process.memoryUsage();
    gauge.set({ type: "used" }, memory.heapUsed);
    gauge.set({ type: "total" }, memory.heapTotal);
    gauge.set({ type: "external" }, memory.external);
    gauge.set({ type: "array_buffers" }, memory.arrayBuffers);
  });

  const gcPauses = target.histogram("gc_pause_seconds", "Garbage-collection pauses by kind", GC_BUCKETS, ["kind"]);
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = (entry as { detail?: { kind?: number } | null }).detail?.kind;
      gcPauses.observe({ kind: (kind !== undefined && GC_KINDS[kind]) || "other" }, entry.duration / 1000);
    }
  });
  observer.observe({ entryTypes: ["gc"] });

  return () => {
    clearInterval(minuteTimer);
    perScrape.disable();
    perMinute.disable();
    observer.disconnect();
  };
}

/** Nanosecond percentiles as seconds; an empty histogram reads as zero. */
function delayStats(histogram: IntervalHistogram): { p50: number; p99: number; max: number } {
  if (histogram.count === 0) return { p50: 0, p99: 0, max: 0 };
  return {
    p50: histogram.percentile(50) / 1e9,
    p99: histogram.percentile(99) / 1e9,
    max: histogram.max / 1e9,
  };
}

// -- Real-user timings ----------------------------------------------------------

/**
 * The web app's pages, as templates. A browser reports the path it measured
 * on; this is what keeps that from becoming a label value per project, per
 * session, per note: a path is only ever recorded as one of these, or as
 * `other`. Kept in step with `apps/web/src/app` (route groups dropped).
 */
const ROUTE_TEMPLATES: readonly string[] = [
  "/",
  "/login",
  "/invite/[token]",
  "/setting",
  "/setting/[page]",
  "/dev/themes",
  "/shared/[slug]",
  "/shared/[slug]/documents",
  "/shared/[slug]/notes",
  "/shared/[slug]/notes/[note]",
  "/shared/[slug]/timeline",
  "/[workspace]",
  "/[workspace]/code",
  "/[workspace]/database",
  "/[workspace]/database/[connection]",
  "/[workspace]/database/[connection]/[db]",
  "/[workspace]/database/[connection]/[db]/[table]",
  "/[workspace]/publish",
  "/[workspace]/s/[session]",
  "/[workspace]/todo",
  "/[workspace]/workspace-settings",
  "/[workspace]/workspace-settings/[page]",
  "/[workspace]/p/[project]",
  "/[workspace]/p/[project]/[session]",
  "/[workspace]/p/[project]/activity",
  "/[workspace]/p/[project]/documentation",
  "/[workspace]/p/[project]/documentation/[note]",
  "/[workspace]/p/[project]/keys",
  "/[workspace]/p/[project]/manage",
  "/[workspace]/p/[project]/tasks",
  "/[workspace]/p/[project]/timeline",
];

const TEMPLATE_SEGMENTS = ROUTE_TEMPLATES.map((template) => ({
  template,
  segments: template.split("/").filter(Boolean),
}));

/**
 * The template a path belongs to: of those with as many segments whose
 * literal segments all match, the one matching the most literally, so
 * `/x/p/y/tasks` is the tasks page rather than a session called "tasks".
 */
export function routeTemplate(path: string): string {
  if (typeof path !== "string" || path.length > 512 || !path.startsWith("/")) return "other";
  const segments = path.split("?")[0]!.split("/").filter(Boolean);
  let best: { template: string; literal: number } | null = null;
  for (const { template, segments: pattern } of TEMPLATE_SEGMENTS) {
    if (pattern.length !== segments.length) continue;
    let literal = 0;
    let matches = true;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i]!.startsWith("[")) continue;
      if (pattern[i] !== segments[i]) {
        matches = false;
        break;
      }
      literal++;
    }
    if (matches && (!best || literal > best.literal)) best = { template, literal };
  }
  return best?.template ?? "other";
}

/** Timings the browser reports, in milliseconds; CLS is a unitless score. */
const TIMED_VITALS = new Set(["LCP", "INP", "TTFB", "nav-skeleton", "nav-content", "frame-to-paint", "keystroke-to-echo"]);

/** From a frame to a slow page load, in seconds. */
const VITAL_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.016, 0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 2.5, 4, 6, 10, 20,
];
const CLS_BUCKETS: readonly number[] = [0.01, 0.05, 0.1, 0.15, 0.25, 0.5, 1];

/** The most entries one report may carry; the web app sends at most this. */
export const MAX_VITALS_PER_REPORT = 50;

/**
 * Folds one `POST /api/metrics/vitals` body into the histograms, and returns
 * how many entries it kept -- or null when the body is not a report at all.
 * Unknown names, values out of range and anything past the cap are dropped:
 * the sender is a browser, so nothing it says is trusted to be well formed.
 */
export function recordVitals(body: unknown, target: Registry = registry): number | null {
  const vitals = (body as { vitals?: unknown } | null)?.vitals;
  if (!Array.isArray(vitals)) return null;
  const timed = target.histogram("web_vital_seconds", "Real-user timings from the web app, by name and route template", VITAL_BUCKETS, [
    "name",
    "route",
  ]);
  const cls = target.histogram("web_vital_cls", "Real-user cumulative layout shift, by route template", CLS_BUCKETS, ["route"]);
  let kept = 0;
  for (const entry of vitals.slice(0, MAX_VITALS_PER_REPORT)) {
    const { name, value, path } = (entry ?? {}) as { name?: unknown; value?: unknown; path?: unknown };
    if (typeof name !== "string" || typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    const route = routeTemplate(typeof path === "string" ? path : "");
    if (name === "CLS") {
      if (value > 100) continue;
      cls.observe({ route }, value);
    } else if (TIMED_VITALS.has(name)) {
      // A tab that slept mid-measurement reports hours; nothing real is.
      if (value > 120_000) continue;
      timed.observe({ name, route }, value / 1000);
    } else continue;
    kept++;
  }
  return kept;
}
