#!/usr/bin/env node
/**
 * Folds one profile.sh run into the figures documentation/perf/ keeps:
 *
 *   node scripts/load/summarise.mjs documentation/perf/baseline-2026-10-25
 *
 * Writes `<dir>.json` beside the directory -- every figure the Definition of
 * Done in documentation/todo.md asks for, plus what PF0.9 records about the
 * run -- and prints the Definition of Done rows as a Markdown table.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const dir = process.argv[2]?.replace(/\/+$/, "");
if (!dir || !existsSync(dir)) {
  console.error("usage: summarise.mjs <profile directory>");
  process.exit(2);
}
const read = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null);
// The repeated runs, `<prefix>-1.json` onwards -- not `stream-2000-idle` or
// `stream-4000`, which are one-offs of their own.
const numbered = (prefix) =>
  readdirSync(dir)
    .filter((f) => new RegExp(`^${prefix}-\\d{1,2}\\.json$`).test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
const sorted = (values) => values.filter((v) => typeof v === "number" && v >= 0).sort((a, b) => a - b);
const quantile = (values, q) => {
  const s = sorted(values);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10 : null;
};
const median = (values) => quantile(values, 0.5);

const load = read("load.json");
const load4000 = read("load-4000.json");
const signinIdle = read("signin-idle.json");
const signinLoad = numbered("signin-load");
const tab = read("tab.json");
const git = read("git-burst.json");
const claude = read("claude-burst.json");
const big = read("bootstrap-big.json");
const stream2000 = read("stream-2000-idle.json");
const stream4000 = read("stream-4000.json");
const stream4000Slow = read("stream-4000-cpu4x.json");
const streams = numbered("stream");
const perfs = numbered("perf");

// perf.spec walks its routes twice: the first pass is each page's first
// visit, the second ("(again)") a return the client cache should serve.
const hops = perfs.flatMap((p) => p.hops);
const again = hops.filter((h) => h.name.endsWith("(again)"));
const firstVisit = hops.filter((h) => !h.name.endsWith("(again)"));

// The shell route: the smallest first load among the signed-in app's
// routes, which is the shell and the least page code (bundle-budget.mjs).
const bundle = existsSync(join(dir, "bundle.txt")) ? readFileSync(join(dir, "bundle.txt"), "utf8") : "";
const appRoutes = [...bundle.matchAll(/^\s*(\d+) kB\s+(\/\(app\)\S*)$/gm)].map((m) => ({ kB: Number(m[1]), route: m[2] }));
const shell = appRoutes.sort((a, b) => a.kB - b.kB)[0] ?? null;

// `docker stats` every 5 s during the run: CPU in cores, memory in MiB, per
// container. The load-test Postgres is its own container, so this is the
// only place its share shows (the resource sampler sees one cgroup).
const docker = {};
if (existsSync(join(dir, "docker-stats.txt"))) {
  for (const line of readFileSync(join(dir, "docker-stats.txt"), "utf8").split("\n")) {
    const m = line.match(/^(\S+) ([\d.]+)% ([\d.]+)(MiB|GiB)/);
    if (!m) continue;
    const entry = (docker[m[1]] ??= { cpu: [], mem: [] });
    entry.cpu.push(Number(m[2]) / 100);
    entry.mem.push(Number(m[3]) * (m[4] === "GiB" ? 1024 : 1));
  }
}
const mean = (values) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100 : null);
const containers = Object.fromEntries(
  Object.entries(docker).map(([name, { cpu, mem }]) => [
    name,
    {
      cpuCores: { mean: mean(cpu), max: Math.round(Math.max(...cpu) * 100) / 100 },
      memMiB: { mean: mean(mem), max: Math.round(Math.max(...mem)) },
      samples: cpu.length,
    },
  ]),
);

const pgTop = existsSync(join(dir, "pg-top.txt")) ? readFileSync(join(dir, "pg-top.txt"), "utf8") : "";

const summary = {
  label: basename(dir),
  at: load?.startedAt ?? null,
  target: load ? { base: load.base, users: load.users, minutes: load.minutes, mix: load.mix, roles: load.roles } : null,
  definitionOfDone: {
    rscPerFreshSignIn: signinIdle ? signinIdle.requests.rsc + signinIdle.requests.rscPrefetch : null,
    rscPerOtherTabOnSettingsSave: tab ? tab.settingsSave.requests.rsc + tab.settingsSave.requests.rscPrefetch : null,
    signInToInteractiveMs: {
      idle: signinIdle?.interactiveMs ?? null,
      underLoad: signinLoad.map((s) => s.interactiveMs),
      underLoadMedian: median(signinLoad.map((s) => s.interactiveMs)),
    },
    clickToSkeletonP95Ms: quantile(hops.map((h) => h.paint), 0.95),
    clickToContentCachedP95Ms: quantile(again.map((h) => h.content), 0.95),
    clickToContentColdP95Ms: quantile(firstVisit.map((h) => h.content), 0.95),
    perfSuiteRuns: perfs.length,
    bootstrapBigP95Ms: big?.p95 ?? null,
    bootstrapBig: big,
    keystrokeEchoMs: load ? { p95: load.client.keystroke_echo_ms?.p95, p99: load.client.keystroke_echo_ms?.p99 } : null,
    engineWaitP99Ms: load?.server?.engineWaitMs.p99 ?? null,
    framesPer2000TokenAnswer: stream2000?.received.frames ?? null,
    longTasksStreaming4000: stream4000?.longTasks ?? null,
    longTasksStreaming4000Cpu4x: stream4000Slow?.longTasks ?? null,
    inpWhileStreamingMs: { runs: streams.map((s) => s.inp.ms), median: median(streams.map((s) => s.inp.ms)), max: Math.max(...streams.map((s) => s.inp.ms)) },
    gitProcessesPerBurst: git ? { ...git } : null,
    claudeBurst: claude,
    subscriptionsPerSocket: tab?.tab.subscriptions ?? null,
    wsPerTab: tab?.tab.socketsOpen ?? null,
    apiRssMaxMb: load?.server?.apiRssMb.max ?? null,
    eventLoopDelayP99Ms: load?.server ? { medianScrape: load.server.eventLoopDelayP99Ms.p50, worstScrape: load.server.eventLoopDelayP99Ms.max } : null,
    oomKills: load?.server?.cgroupOomKills ?? null,
    shellRouteFirstLoadKb: shell,
  },
  run: load
    ? {
        cpuCoresByGroup: load.server?.cpuCoresByGroup,
        containers,
        rssMbByGroup: Object.fromEntries(
          Object.entries(load.server?.rssMbByGroup ?? {})
            .filter(([, s]) => s.count && s.max > 0)
            .map(([g, s]) => [g, { mean: s.mean, max: s.max }]),
        ),
        peakProcessesByGroup: load.server?.peakProcessesByGroup,
        eventLoopUtilization: load.server?.eventLoopUtilization,
        cgroupMemoryMaxMb: load.server?.cgroupMemoryMb.max,
        engineWaitMs: load.server?.engineWaitMs,
        engineProcessMs: load.server?.engineProcessMs,
        wsConnections: load.server?.wsConnections.max,
        wsSubscriptions: Object.fromEntries(Object.entries(load.server?.wsSubscriptions ?? {}).map(([k, v]) => [k, v.max])),
        webRequests: load.server?.webRequests,
        bootstrapRequests: load.server?.bootstrapRequests,
        client: load.client,
        errors: load.errors,
        framesPerTurn: load.client.turn_frames,
        tokenToPaintMs: { runs: streams.map((s) => s.frameToPaintMs.p95), medianP95: median(streams.map((s) => s.frameToPaintMs.p95)) },
        streamLongTasks: streams.map((s) => s.longTasks),
        navSkeletonP95Ms: quantile(hops.map((h) => h.paint), 0.95),
        peakClaudeProcesses: claude?.processes?.claude.peak ?? null,
      }
    : null,
  load4000: load4000 ? { errors: load4000.errors, client: { keystroke_echo_ms: load4000.client.keystroke_echo_ms } } : null,
  stream4000,
  stream4000Cpu4x: stream4000Slow,
  pgTop: pgTop.split("\n").slice(0, 40).join("\n"),
};
writeFileSync(`${dir}.json`, `${JSON.stringify(summary, null, 2)}\n`);

const d = summary.definitionOfDone;
const rows = [
  ["RSC requests caused by one fresh sign-in", d.rscPerFreshSignIn],
  ["RSC requests in other tabs when a member saves settings", d.rscPerOtherTabOnSettingsSave === null ? null : `${d.rscPerOtherTabOnSettingsSave} per tab`],
  ["Sign-in submit → interactive shell", `${(d.signInToInteractiveMs.underLoadMedian / 1000).toFixed(2)} s under load (idle ${(d.signInToInteractiveMs.idle / 1000).toFixed(2)} s)`],
  ["Click → skeleton or new page (p95)", `${d.clickToSkeletonP95Ms} ms`],
  ["Click → content, cached data (p95)", `${d.clickToContentCachedP95Ms} ms`],
  ["Click → content, cold data (p95)", `${d.clickToContentColdP95Ms} ms`],
  ["Bootstrap server time (200 projects / 20k turns, p95)", `${d.bootstrapBigP95Ms} ms`],
  ["Terminal keystroke echo (p95 / p99)", `${d.keystrokeEchoMs.p95} / ${d.keystrokeEchoMs.p99} ms`],
  // Every observation in the histogram's first bucket (<= 1 ms) reads as 0.99.
  ["Engine wait (p99)", d.engineWaitP99Ms !== null && d.engineWaitP99Ms < 1 ? "< 1 ms" : `${d.engineWaitP99Ms} ms`],
  ["WebSocket frames per 2,000-token answer", d.framesPer2000TokenAnswer],
  [
    "Long tasks > 50 ms while streaming a 4,000-token answer",
    `${d.longTasksStreaming4000?.count} (${d.longTasksStreaming4000Cpu4x?.count ?? "—"} with the CPU throttled 4×)`,
  ],
  ["INP while streaming", `${d.inpWhileStreamingMs.max} ms (worst of ${d.inpWhileStreamingMs.runs.length})`],
  ["Git processes per file-change burst, 10 viewers", d.gitProcessesPerBurst?.gitProcesses],
  ["Concurrent `claude` processes during a 20-turn burst", d.claudeBurst ? `${d.claudeBurst.processes.claude.peak}, ${d.claudeBurst.outcomes.completed ?? 0} of ${d.claudeBurst.turns} completed` : null],
  [
    "Subscriptions per socket",
    d.subscriptionsPerSocket
      ?.map((s) => (s.total ? `${s.total} (${Object.entries(s.byKind).map(([k, n]) => `${n} ${k}`).join(", ")})` : "0"))
      .join(" + "),
  ],
  ["`/ws` connections per tab", d.wsPerTab],
  ["API RSS under load", `${d.apiRssMaxMb} MB`],
  ["Event-loop delay p99 under load", `${d.eventLoopDelayP99Ms.worstScrape} ms`],
  ["cgroup `oom_kill` during the run", d.oomKills],
  ["Shell-route first-load JS", d.shellRouteFirstLoadKb ? `${d.shellRouteFirstLoadKb.kB} kB gz (${d.shellRouteFirstLoadKb.route})` : null],
];
console.log("| Metric | Measured |\n| --- | --- |");
for (const [name, value] of rows) console.log(`| ${name} | ${value ?? "—"} |`);
