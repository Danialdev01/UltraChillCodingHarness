import { describe, expect, it } from "vitest";
import { MAX_VITALS_PER_REPORT, metricsAccess, recordVitals, Registry, routeTemplate, startRuntimeMetrics } from "./metrics.js";

describe("Registry", () => {
  it("renders counters and gauges in the Prometheus text format", async () => {
    const registry = new Registry();
    const frames = registry.counter("frames_total", "Frames sent", ["kind"]);
    frames.inc({ kind: "push" });
    frames.inc({ kind: "push" }, 2);
    frames.inc({ kind: "ack" });
    registry.gauge("open", "Open things").set(undefined, 4);

    expect(await registry.render()).toBe(
      [
        "# HELP frames_total Frames sent",
        "# TYPE frames_total counter",
        'frames_total{kind="push"} 3',
        'frames_total{kind="ack"} 1',
        "# HELP open Open things",
        "# TYPE open gauge",
        "open 4",
        "",
      ].join("\n"),
    );
  });

  it("renders cumulative histogram buckets, +Inf, sum and count", async () => {
    const registry = new Registry();
    const wait = registry.histogram("wait_seconds", "Wait", [0.1, 1], ["command"]);
    wait.observe({ command: "a" }, 0.05);
    wait.observe({ command: "a" }, 0.5);
    wait.observe({ command: "a" }, 5);

    const text = await registry.render();
    expect(text).toContain('wait_seconds_bucket{command="a",le="0.1"} 1');
    expect(text).toContain('wait_seconds_bucket{command="a",le="1"} 2');
    expect(text).toContain('wait_seconds_bucket{command="a",le="+Inf"} 3');
    expect(text).toContain('wait_seconds_sum{command="a"} 5.55');
    expect(text).toContain('wait_seconds_count{command="a"} 3');
  });

  it("escapes label values and help text", async () => {
    const registry = new Registry();
    registry.counter("odd_total", "Back\\slash\nnewline", ["route"]).inc({ route: 'a"b\\c\nd' });
    const text = await registry.render();
    expect(text).toContain("# HELP odd_total Back\\\\slash\\nnewline");
    expect(text).toContain('odd_total{route="a\\"b\\\\c\\nd"} 1');
  });

  it("runs gauge collectors before rendering and survives one that throws", async () => {
    const registry = new Registry();
    let n = 0;
    registry.gauge("live", "Collected", [], (gauge) => gauge.set(undefined, ++n));
    registry.gauge("broken", "Throws", [], () => {
      throw new Error("down");
    });
    expect(await registry.render()).toContain("live 1");
    expect(await registry.render()).toContain("live 2");
  });

  it("returns the existing family for a repeated name and refuses a different kind", () => {
    const registry = new Registry();
    const a = registry.counter("x_total", "X");
    expect(registry.counter("x_total", "X")).toBe(a);
    expect(() => registry.gauge("x_total", "X")).toThrow(/already a counter/);
  });

  it("reports runtime families", async () => {
    const registry = new Registry();
    const stop = startRuntimeMetrics(registry);
    try {
      const text = await registry.render();
      for (const family of [
        "event_loop_delay_seconds",
        "event_loop_utilization",
        "process_rss_bytes",
        "process_heap_bytes",
        "gc_pause_seconds",
      ]) {
        expect(text).toContain(`# TYPE ${family} `);
      }
      expect(text).toContain('event_loop_delay_seconds{window="scrape",quantile="0.99"}');
    } finally {
      stop();
    }
  });
});

describe("metricsAccess", () => {
  const token = "a-long-enough-metrics-token";

  it("with a token, admits only the matching bearer token", () => {
    expect(metricsAccess({ authorization: `Bearer ${token}`, remoteAddress: "10.0.0.5", token })).toBe(true);
    expect(metricsAccess({ authorization: "Bearer wrong", remoteAddress: "10.0.0.5", token })).toBe(false);
    expect(metricsAccess({ authorization: `Bearer ${token}x`, remoteAddress: "10.0.0.5", token })).toBe(false);
    // Loopback is no substitute for the token once one is configured.
    expect(metricsAccess({ authorization: undefined, remoteAddress: "127.0.0.1", token })).toBe(false);
  });

  it("without a token, admits loopback only", () => {
    for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(metricsAccess({ authorization: undefined, remoteAddress, token: undefined })).toBe(true);
    }
    for (const remoteAddress of ["172.17.0.1", "10.0.0.5", "::ffff:10.0.0.5", undefined]) {
      expect(metricsAccess({ authorization: undefined, remoteAddress, token: undefined })).toBe(false);
    }
  });
});

describe("routeTemplate", () => {
  it("names a page by its template, never by its hashes", () => {
    expect(routeTemplate("/")).toBe("/");
    expect(routeTemplate("/login")).toBe("/login");
    expect(routeTemplate("/setting/account")).toBe("/setting/[page]");
    expect(routeTemplate("/k3j2h1")).toBe("/[workspace]");
    expect(routeTemplate("/k3j2h1/p/9x8y7z")).toBe("/[workspace]/p/[project]");
    expect(routeTemplate("/k3j2h1/p/9x8y7z/a1b2c3")).toBe("/[workspace]/p/[project]/[session]");
    expect(routeTemplate("/k3j2h1/p/9x8y7z/documentation/42")).toBe("/[workspace]/p/[project]/documentation/[note]");
    expect(routeTemplate("/shared/some-slug/notes")).toBe("/shared/[slug]/notes");
  });

  it("prefers a literal segment to a parameter", () => {
    // A session hash could be anything, but "tasks" is the tasks page.
    expect(routeTemplate("/k3j2h1/p/9x8y7z/tasks")).toBe("/[workspace]/p/[project]/tasks");
    expect(routeTemplate("/k3j2h1/workspace-settings/members")).toBe("/[workspace]/workspace-settings/[page]");
  });

  it("puts everything else under one label", () => {
    expect(routeTemplate("/a/b/c/d/e/f/g")).toBe("other");
    expect(routeTemplate("/k3j2h1/nowhere")).toBe("other");
    expect(routeTemplate("relative")).toBe("other");
    expect(routeTemplate(`/${"x".repeat(600)}`)).toBe("other");
  });
});

describe("recordVitals", () => {
  it("files timings in seconds and CLS as a score, by route template", async () => {
    const registry = new Registry();
    const kept = recordVitals(
      {
        vitals: [
          { name: "LCP", value: 1200, path: "/k3j2h1" },
          { name: "nav-skeleton", value: 40, path: "/k3j2h1/p/9x8y7z/tasks" },
          { name: "CLS", value: 0.02, path: "/login" },
        ],
      },
      registry,
    );
    expect(kept).toBe(3);
    const text = await registry.render();
    expect(text).toContain('web_vital_seconds_sum{name="LCP",route="/[workspace]"} 1.2');
    expect(text).toContain('web_vital_seconds_count{name="nav-skeleton",route="/[workspace]/p/[project]/tasks"} 1');
    expect(text).toContain('web_vital_cls_sum{route="/login"} 0.02');
    // Nothing of the path itself survives.
    expect(text).not.toContain("k3j2h1");
  });

  it("drops what is not a timing it knows, and stops at the cap", () => {
    const registry = new Registry();
    expect(
      recordVitals(
        {
          vitals: [
            { name: "made-up", value: 5, path: "/" },
            { name: "INP", value: -1, path: "/" },
            { name: "INP", value: Number.NaN, path: "/" },
            { name: "INP", value: "fast", path: "/" },
            { name: "TTFB", value: 10 * 60_000, path: "/" },
            null,
            { name: "INP", value: 80, path: "/" },
          ],
        },
        registry,
      ),
    ).toBe(1);
    const many = Array.from({ length: MAX_VITALS_PER_REPORT + 10 }, () => ({ name: "INP", value: 10, path: "/" }));
    expect(recordVitals({ vitals: many }, registry)).toBe(MAX_VITALS_PER_REPORT);
  });

  it("refuses a body that is not a report", () => {
    expect(recordVitals(null, new Registry())).toBeNull();
    expect(recordVitals({ vitals: "LCP" }, new Registry())).toBeNull();
    expect(recordVitals("text", new Registry())).toBeNull();
  });
});
