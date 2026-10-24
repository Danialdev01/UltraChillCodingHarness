#!/usr/bin/env node
/**
 * The load generator: N virtual users doing what people do in UCCH, against
 * a seeded server (README.md, "Seeding"), measured from the outside and
 * from `/metrics`.
 *
 *   node scripts/load/run.mjs --sessions load-out/sessions.json \
 *     --users 50 --minutes 10 --out documentation/perf/baseline-2026-10-24.json \
 *     [--base http://127.0.0.1:3397] [--metrics-token T] [--ramp 30]
 *     [--mix native=0.2,terminal=0.3,git=0.3] [--turn-every 60] [--git-every 60]
 *     [--poll-every 30] [--type-rate 5]
 *
 * Every virtual user, as the browser does (solution.md §1):
 *   - takes a ws-ticket and opens /ws, subscribing to `user`, the shared
 *     workspace, and a quiet `project` topic for each of its projects -- the
 *     sidebar today -- plus its own thread, with replay;
 *   - every --poll-every seconds fetches /api/bootstrap, one page document
 *     and five RSC prefetches through the edge;
 * and by role (the rest only watch):
 *   - native:   sends a native turn every --turn-every s (the mock streams it);
 *   - terminal: types --type-rate characters a second into a shell;
 *   - git:      reads status, branches and the first log page every
 *               --git-every s, as the Git view does.
 *
 * Measured on the client: ack round trip by command; keystroke echo (send
 * until the `terminal.output` holding that character); frames, bytes and
 * time per turn; bootstrap, document (time to first byte), RSC prefetch and
 * git latencies; errors by kind. `/metrics` is scraped every 5 s (it needs
 * METRICS_TOKEN from outside the container).
 *
 * Writes the JSON result to --out and a Markdown summary beside it.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    sessions: { type: "string", default: "load-out/sessions.json" },
    base: { type: "string" },
    users: { type: "string", default: "50" },
    minutes: { type: "string", default: "10" },
    out: { type: "string", default: `load-out/run-${new Date().toISOString().slice(0, 10)}.json` },
    "metrics-token": { type: "string", default: process.env.METRICS_TOKEN ?? "" },
    ramp: { type: "string", default: "30" },
    mix: { type: "string", default: "native=0.2,terminal=0.3,git=0.3" },
    "turn-every": { type: "string", default: "60" },
    "git-every": { type: "string", default: "60" },
    "poll-every": { type: "string", default: "30" },
    "type-rate": { type: "string", default: "5" },
    "scrape-every": { type: "string", default: "5" },
    label: { type: "string", default: "" },
  },
});

const seeded = JSON.parse(await readFile(args.sessions, "utf8"));
const BASE = (args.base ?? seeded.base).replace(/\/+$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const USERS = Math.min(Number(args.users), seeded.users.length);
const DURATION_MS = Number(args.minutes) * 60_000;
const RAMP_MS = Number(args.ramp) * 1000;
const TURN_EVERY = Number(args["turn-every"]) * 1000;
const GIT_EVERY = Number(args["git-every"]) * 1000;
const POLL_EVERY = Number(args["poll-every"]) * 1000;
const TYPE_INTERVAL = 1000 / Number(args["type-rate"]);
const SCRAPE_EVERY = Number(args["scrape-every"]) * 1000;
const mix = Object.fromEntries(args.mix.split(",").map((part) => part.split("=")).map(([k, v]) => [k, Number(v)]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (ms) => ms * (0.5 + Math.random());
/** Sleeps `ms`, but never past `stopAt`: the run ends when it says it does. */
const pause = (ms, stopAt) => sleep(Math.max(0, Math.min(ms, stopAt - Date.now())));

// -- Measurements --------------------------------------------------------------

/** Raw samples per name, summarised at the end. */
const samples = new Map();
const record = (name, value) => {
  let list = samples.get(name);
  if (!list) samples.set(name, (list = []));
  list.push(value);
};
const errors = new Map();
const countError = (kind) => errors.set(kind, (errors.get(kind) ?? 0) + 1);

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (n) => Math.round(n * 100) / 100;
  if (sorted.length === 0) return { count: 0 };
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
  };
}

// -- HTTP ----------------------------------------------------------------------

async function timed(name, url, init) {
  const started = performance.now();
  try {
    const response = await fetch(url, init);
    const firstByte = performance.now() - started;
    const body = await response.arrayBuffer();
    const total = performance.now() - started;
    if (!response.ok && response.status !== 304) countError(`${name}:${response.status}`);
    return { response, body, firstByte, total };
  } catch (error) {
    countError(`${name}:network`);
    return null;
  }
}

// -- One WebSocket, as the browser holds it --------------------------------------

class Socket {
  #ws;
  #pending = new Map();
  #listeners = new Set();
  #next = 0;
  frames = 0;
  bytes = 0;

  static async open(cookie) {
    const response = await fetch(`${BASE}/api/ws-ticket`, { method: "POST", headers: { cookie, origin: BASE } });
    if (!response.ok) throw new Error(`ws-ticket ${response.status}`);
    const { ticket } = await response.json();
    const socket = new Socket(new WebSocket(`${WS_BASE}/ws?ticket=${encodeURIComponent(ticket)}`));
    await socket.#opened;
    return socket;
  }

  constructor(ws) {
    this.#ws = ws;
    this.#opened = new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    });
    ws.addEventListener("message", (message) => {
      const data = String(message.data);
      this.frames++;
      this.bytes += Buffer.byteLength(data);
      const frame = JSON.parse(data);
      if ((frame.kind === "ack" || frame.kind === "error") && frame.id !== null) {
        const waiter = this.#pending.get(frame.id);
        if (waiter) {
          this.#pending.delete(frame.id);
          waiter(frame);
        }
      }
      for (const listener of this.#listeners) listener(frame, data);
    });
    ws.addEventListener("close", () => {
      if (!this.closing) countError("ws:closed");
      for (const waiter of this.#pending.values()) waiter({ kind: "error", code: "closed", message: "socket closed" });
      this.#pending.clear();
    });
  }

  #opened;
  closing = false;

  /** Sends a frame that is acked, and records the round trip under `label`. */
  request(frame, label) {
    const id = `r${++this.#next}`;
    const started = performance.now();
    return new Promise((resolve) => {
      this.#pending.set(id, (answer) => {
        record(`ack_ms:${label}`, performance.now() - started);
        if (answer.kind === "error") countError(`${label}:${answer.code}`);
        resolve(answer);
      });
      try {
        this.#ws.send(JSON.stringify({ ...frame, id }));
      } catch {
        this.#pending.delete(id);
        resolve({ kind: "error", code: "closed" });
      }
    });
  }

  dispatch(command) {
    return this.request({ kind: "dispatch", command }, command.type);
  }

  subscribe(topic, extra = {}) {
    return this.request({ kind: "subscribe", topic, ...extra }, `subscribe:${topic.name}`);
  }

  on(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.closing = true;
    this.#ws.close();
  }
}

// -- A virtual user ----------------------------------------------------------------

const PROJECT_PAGES = ["", "/tasks", "/timeline", "/documentation", "/activity"];

function roleOf(index) {
  // Spread the roles evenly over the user list rather than in blocks.
  const position = (index * 0.618033988749895) % 1;
  let edge = 0;
  for (const role of ["native", "terminal", "git"]) {
    edge += mix[role] ?? 0;
    if (position < edge) return role;
  }
  return "watch";
}

async function virtualUser(index, stopAt) {
  const user = seeded.users[index];
  const headers = { cookie: user.cookie, origin: BASE };
  const role = roleOf(index);

  const boot = await timed("bootstrap", `${BASE}/api/bootstrap`, { headers });
  if (!boot?.response.ok) throw new Error(`bootstrap ${boot?.response.status}`);
  const first = JSON.parse(Buffer.from(boot.body).toString("utf8"));
  const shared = first.workspaces.find((w) => w.id === seeded.sharedWorkspaceId);
  const bootstrapUrl = `${BASE}/api/bootstrap?ws=${shared.hash}&hint=${shared.id}`;
  const listed = await timed("bootstrap", bootstrapUrl, { headers });
  const { projects } = JSON.parse(Buffer.from(listed.body).toString("utf8"));
  const project = projects[index % projects.length];

  const socket = await Socket.open(user.cookie);
  await socket.subscribe({ name: "user" });
  await socket.subscribe({ name: "workspace", workspaceId: shared.id });
  for (const p of projects) await socket.subscribe({ name: "project", projectId: p.id, quiet: true });

  // The user's own thread in its project, found again on later runs.
  const title = `load-vu-${index}`;
  const threads = await timed("threads", `${BASE}/api/projects/${project.hash}/threads`, { headers });
  let threadId = threads?.response.ok
    ? JSON.parse(Buffer.from(threads.body).toString("utf8")).threads?.find((t) => t.title === title)?.id
    : undefined;
  if (!threadId) {
    const created = await socket.dispatch({ type: "thread.create", projectId: project.id, title });
    threadId = created.events?.find((e) => e.event.type === "thread.created")?.event.threadId;
  }
  if (!threadId) throw new Error("no thread");
  await socket.subscribe({ name: "thread", threadId });

  const tasks = [poll(socket, headers, shared, projects, bootstrapUrl, stopAt)];
  if (role === "native") tasks.push(turns(socket, threadId, stopAt));
  if (role === "terminal") tasks.push(typing(socket, project, stopAt));
  if (role === "git") tasks.push(gitReads(headers, project, stopAt));
  await Promise.all(tasks);
  socket.close();
  return role;
}

async function poll(socket, headers, shared, projects, bootstrapUrl, stopAt) {
  await pause(Math.random() * POLL_EVERY, stopAt);
  let etag = null;
  while (Date.now() < stopAt) {
    const boot = await timed("bootstrap", bootstrapUrl, { headers: { ...headers, ...(etag ? { "if-none-match": etag } : {}) } });
    if (boot) {
      record("bootstrap_ms", boot.total);
      etag = boot.response.headers.get("etag") ?? etag;
    }
    const doc = await timed("document", `${BASE}/${shared.hash}`, { headers: { ...headers, accept: "text/html" } });
    if (doc) record("document_ttfb_ms", doc.firstByte);
    await Promise.all(
      Array.from({ length: 5 }, async () => {
        const p = projects[Math.floor(Math.random() * projects.length)];
        const page = PROJECT_PAGES[Math.floor(Math.random() * PROJECT_PAGES.length)];
        const rsc = await timed("rsc_prefetch", `${BASE}/${shared.hash}/p/${p.hash}${page}`, {
          headers: { ...headers, rsc: "1", "next-router-prefetch": "1" },
        });
        if (rsc) record("rsc_prefetch_ms", rsc.total);
      }),
    );
    await pause(jitter(POLL_EVERY), stopAt);
  }
}

async function turns(socket, threadId, stopAt) {
  await pause(Math.random() * TURN_EVERY, stopAt);
  while (Date.now() < stopAt) {
    const frames0 = socket.frames;
    const bytes0 = socket.bytes;
    const started = performance.now();
    let firstDelta = null;
    let deltas = 0;
    const ended = new Promise((resolve) => {
      const off = socket.on((frame) => {
        if (frame.kind !== "push" || frame.event.threadId !== threadId) return;
        if (frame.event.type === "agent.text_delta") {
          deltas++;
          firstDelta ??= performance.now() - started;
        }
        if (frame.event.type === "agent.turn_completed" || frame.event.type === "agent.turn_failed") {
          off();
          resolve(frame.event.type);
        }
      });
      // A turn still streaming when the run ends is left, not waited for.
      setTimeout(() => {
        off();
        resolve(Date.now() >= stopAt ? "unfinished" : "timeout");
      }, Math.max(1000, Math.min(180_000, stopAt + 5_000 - Date.now())));
    });
    const ack = await socket.dispatch({ type: "thread.send", threadId, text: "Explain what you would change.", provider: "native" });
    const outcome = ack.kind === "ack" ? await ended : "refused";
    if (outcome === "agent.turn_completed") {
      record("turn_ms", performance.now() - started);
      record("turn_frames", socket.frames - frames0);
      record("turn_bytes", socket.bytes - bytes0);
      record("turn_delta_frames", deltas);
      if (firstDelta !== null) record("turn_first_token_ms", firstDelta);
    } else if (outcome !== "unfinished") {
      countError(`turn:${outcome}`);
    }
    await pause(jitter(TURN_EVERY), stopAt);
  }
}

async function typing(socket, project, stopAt) {
  const terminalId = randomUUID();
  const pending = [];
  let prompted = false;
  socket.on((frame) => {
    if (frame.kind !== "push" || frame.event.type !== "terminal.output" || frame.event.terminalId !== terminalId) return;
    prompted = true;
    const now = performance.now();
    // Echo comes back in the order it was typed; match each character to
    // the oldest one still waiting.
    for (const ch of frame.event.data) {
      if (pending.length > 0 && ch === pending[0].ch) record("keystroke_echo_ms", now - pending.shift().at);
    }
  });
  await socket.subscribe({ name: "terminal", terminalId });
  const created = await socket.dispatch({ type: "terminal.create", projectId: project.id, terminalId, cols: 120, rows: 30 });
  if (created.kind !== "ack") return;
  for (let i = 0; i < 100 && !prompted; i++) await sleep(100);

  const LETTERS = "abcdefghijklmnopqrstuvwxyz";
  let column = 0;
  while (Date.now() < stopAt) {
    // A comment line, so Enter runs nothing.
    const ch = column === 0 ? "#" : LETTERS[column % LETTERS.length];
    pending.push({ ch, at: performance.now() });
    void socket.dispatch({ type: "terminal.input", terminalId, data: ch });
    column++;
    await sleep(TYPE_INTERVAL);
    if (column >= 40) {
      column = 0;
      void socket.dispatch({ type: "terminal.input", terminalId, data: "\r" });
      await sleep(600);
      // Anything not echoed by now was lost or mismatched behind the prompt.
      if (pending.length > 0) countError("keystroke:unmatched");
      pending.length = 0;
    }
  }
  await socket.dispatch({ type: "terminal.close", terminalId });
}

async function gitReads(headers, project, stopAt) {
  await pause(Math.random() * GIT_EVERY, stopAt);
  const git = `${BASE}/api/projects/${project.hash}/git`;
  while (Date.now() < stopAt) {
    const started = performance.now();
    await Promise.all(
      [
        ["status", `${git}/status`],
        ["branches", `${git}/branches`],
        ["log", `${git}/log?skip=0&limit=50`],
      ].map(async ([name, url]) => {
        const result = await timed(`git_${name}`, url, { headers });
        if (result) record(`git_${name}_ms`, result.total);
      }),
    );
    record("git_refresh_ms", performance.now() - started);
    await pause(jitter(GIT_EVERY), stopAt);
  }
}

// -- /metrics --------------------------------------------------------------------

/** `name{labels} value` lines into a map; histograms keep their buckets. */
function parseMetrics(text) {
  const series = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const space = line.lastIndexOf(" ");
    series[line.slice(0, space)] = Number(line.slice(space + 1));
  }
  return series;
}

const KEEP = /^(event_loop_|process_|gc_pause_seconds_(sum|count)|engine_|ws_|bus_publish_total|agent_turns|terminals_open|watched_projects|resource_|cgroup_|pg_connections|web_requests_total|bootstrap_requests_total|http_request_seconds_(sum|count))/;

const scrapes = [];
async function scrape(startedAt) {
  try {
    const response = await fetch(`${BASE}/metrics`, {
      headers: args["metrics-token"] ? { authorization: `Bearer ${args["metrics-token"]}` } : {},
    });
    if (!response.ok) {
      countError(`metrics:${response.status}`);
      return;
    }
    const all = parseMetrics(await response.text());
    // Buckets stay out of the time series, which would otherwise be mostly
    // buckets; the summary reads them from the first and last scrapes.
    const kept = Object.fromEntries(Object.entries(all).filter(([name]) => KEEP.test(name) && !name.includes("_bucket{")));
    scrapes.push({ t: Math.round((Date.now() - startedAt) / 1000), series: kept, all });
  } catch {
    countError("metrics:network");
  }
}

/** A quantile from a Prometheus histogram's cumulative buckets, summed over its label sets. */
function histogramQuantile(series, name, q, filter = () => true) {
  const buckets = new Map();
  let total = 0;
  for (const [key, value] of Object.entries(series)) {
    if (!key.startsWith(`${name}_bucket{`) || !filter(key)) continue;
    const le = key.match(/le="([^"]+)"/)?.[1];
    const bound = le === "+Inf" ? Infinity : Number(le);
    buckets.set(bound, (buckets.get(bound) ?? 0) + value);
    if (bound === Infinity) total += value;
  }
  if (total === 0) return null;
  const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const target = q * total;
  let previousBound = 0;
  let previousCount = 0;
  for (const [bound, count] of sorted) {
    if (count >= target) {
      if (bound === Infinity) return previousBound;
      // Linear within the bucket, as Prometheus does.
      return previousBound + ((bound - previousBound) * (target - previousCount)) / Math.max(1, count - previousCount);
    }
    previousBound = bound;
    previousCount = count;
  }
  return previousBound;
}

/** The difference of two cumulative scrapes, for the families that count up. */
function delta(later, earlier, prefix) {
  const out = {};
  for (const [key, value] of Object.entries(later)) {
    if (!key.startsWith(prefix)) continue;
    out[key] = value - (earlier[key] ?? 0);
  }
  return out;
}

function serverSummary() {
  if (scrapes.length < 2) return null;
  const first = scrapes[0].all;
  const last = scrapes.at(-1).all;
  const seconds = scrapes.at(-1).t - scrapes[0].t || 1;
  const over = (key) => scrapes.map((s) => s.series[key]).filter((v) => v !== undefined);
  const stat = (values) => (values.length ? summarise(values) : { count: 0 });
  const groups = [...new Set(Object.keys(last).filter((k) => k.startsWith("resource_rss_bytes{")).map((k) => k.match(/group="([^"]+)"/)[1]))];
  const window = (key) => {
    // Histogram buckets are cumulative since boot; the run's own share is
    // the last scrape minus the first.
    const diff = {};
    for (const [k, v] of Object.entries(last)) if (k.startsWith(key)) diff[k] = v - (first[k] ?? 0);
    return diff;
  };
  const engine = window("engine_wait_seconds_bucket");
  const engineProcess = window("engine_process_seconds_bucket");
  return {
    seconds,
    eventLoopDelayP99Ms: stat(over('event_loop_delay_seconds{window="scrape",quantile="0.99"}').map((v) => v * 1000)),
    eventLoopDelayMaxMs: stat(over('event_loop_delay_seconds{window="scrape",quantile="1"}').map((v) => v * 1000)),
    eventLoopUtilization: stat(over("event_loop_utilization")),
    apiRssMb: stat(over("process_rss_bytes").map((v) => v / 2 ** 20)),
    apiHeapUsedMb: stat(over('process_heap_bytes{type="used"}').map((v) => v / 2 ** 20)),
    gcPauseSecondsTotal: (last["gc_pause_seconds_sum"] ?? 0) - (first["gc_pause_seconds_sum"] ?? 0),
    rssMbByGroup: Object.fromEntries(groups.map((g) => [g, stat(over(`resource_rss_bytes{group="${g}"}`).map((v) => v / 2 ** 20))])),
    cpuCoresByGroup: Object.fromEntries(
      groups.map((g) => {
        const key = `resource_cpu_seconds_total{group="${g}"}`;
        return [g, Math.round((((last[key] ?? 0) - (first[key] ?? 0)) / seconds) * 1000) / 1000];
      }),
    ),
    peakProcessesByGroup: Object.fromEntries(groups.map((g) => [g, Math.max(0, ...over(`resource_processes{group="${g}"}`))])),
    cgroupMemoryMb: stat(over('cgroup_memory_bytes{type="current"}').map((v) => v / 2 ** 20)),
    cgroupOomKills: (last["cgroup_oom_kills_total"] ?? 0) - (first["cgroup_oom_kills_total"] ?? 0),
    engineWaitMs: {
      p50: ms(histogramQuantile(engine, "engine_wait_seconds", 0.5)),
      p99: ms(histogramQuantile(engine, "engine_wait_seconds", 0.99)),
    },
    engineProcessMs: {
      p50: ms(histogramQuantile(engineProcess, "engine_process_seconds", 0.5)),
      p99: ms(histogramQuantile(engineProcess, "engine_process_seconds", 0.99)),
    },
    engineQueueDepth: stat(over("engine_queue_depth")),
    wsConnections: stat(over("ws_connections")),
    wsSubscriptions: Object.fromEntries(
      Object.keys(last)
        .filter((k) => k.startsWith("ws_subscriptions{"))
        .map((k) => [k.match(/topic="([^"]+)"/)[1], stat(over(k))]),
    ),
    wsFramesOut: delta(last, first, "ws_frames_out_total"),
    wsBytesOut: delta(last, first, "ws_bytes_out_total"),
    webRequests: delta(last, first, "web_requests_total"),
    bootstrapRequests: delta(last, first, "bootstrap_requests_total"),
    watchedProjects: stat(over("watched_projects")),
    pgConnections: Object.fromEntries(
      Object.keys(last)
        .filter((k) => k.startsWith("pg_connections{"))
        .map((k) => [k.match(/state="([^"]+)"/)[1], stat(over(k))]),
    ),
  };
}

const ms = (seconds) => (seconds === null ? null : Math.round(seconds * 100_000) / 100);

// -- Run -------------------------------------------------------------------------

const startedAt = Date.now();
const stopAt = startedAt + RAMP_MS + DURATION_MS;
console.log(`load: ${USERS} users for ${args.minutes} min (+${args.ramp} s ramp) against ${BASE}`);

await scrape(startedAt);
const scraper = setInterval(() => void scrape(startedAt), SCRAPE_EVERY);
const progress = setInterval(() => {
  const echo = samples.get("keystroke_echo_ms") ?? [];
  console.log(
    `  ${Math.round((Date.now() - startedAt) / 1000)} s: ${samples.get("turn_ms")?.length ?? 0} turns, ` +
      `${echo.length} keystrokes, ${[...errors.values()].reduce((a, b) => a + b, 0)} errors`,
  );
}, 30_000);

const roles = {};
await Promise.all(
  Array.from({ length: USERS }, async (_, index) => {
    await sleep((RAMP_MS * index) / USERS);
    try {
      const role = await virtualUser(index, stopAt);
      roles[role] = (roles[role] ?? 0) + 1;
    } catch (error) {
      countError(`user:${error instanceof Error ? error.message : String(error)}`);
    }
  }),
);

clearInterval(scraper);
clearInterval(progress);
await scrape(startedAt);

const client = Object.fromEntries([...samples.entries()].sort().map(([name, values]) => [name, summarise(values)]));
const result = {
  label: args.label || null,
  startedAt: new Date(startedAt).toISOString(),
  base: BASE,
  users: USERS,
  minutes: Number(args.minutes),
  rampSeconds: Number(args.ramp),
  mix,
  roles,
  client,
  errors: Object.fromEntries(errors),
  server: serverSummary(),
  scrapes: scrapes.map(({ t, series }) => ({ t, series })),
};

await mkdir(dirname(args.out), { recursive: true });
await writeFile(args.out, `${JSON.stringify(result, null, 1)}\n`);
await writeFile(args.out.replace(/\.json$/, "") + ".md", markdown(result));
console.log(`wrote ${args.out} and its .md summary`);
process.exit(0);

function markdown(r) {
  const row = (name, s) =>
    `| ${name} | ${s?.count ?? 0} | ${s?.p50 ?? ""} | ${s?.p95 ?? ""} | ${s?.p99 ?? ""} | ${s?.max ?? ""} |`;
  const lines = [
    `# Load run${r.label ? `: ${r.label}` : ""}`,
    "",
    `${r.startedAt} · ${r.users} users · ${r.minutes} min · ${r.base}`,
    "",
    `Roles: ${Object.entries(r.roles).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    "",
    "## Client",
    "",
    "| Measure | n | p50 | p95 | p99 | max |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Object.entries(r.client).map(([name, s]) => row(name, s)),
    "",
    "## Errors",
    "",
    Object.keys(r.errors).length ? Object.entries(r.errors).map(([k, v]) => `- ${k}: ${v}`).join("\n") : "None.",
    "",
  ];
  if (r.server) {
    const s = r.server;
    lines.push(
      "## Server (/metrics)",
      "",
      `- Event-loop delay p99 per scrape: p50 ${s.eventLoopDelayP99Ms.p50} ms, max ${s.eventLoopDelayP99Ms.max} ms`,
      `- Event-loop utilisation: mean ${s.eventLoopUtilization.mean}, max ${s.eventLoopUtilization.max}`,
      `- API RSS: mean ${s.apiRssMb.mean} MB, max ${s.apiRssMb.max} MB; heap used max ${s.apiHeapUsedMb.max} MB`,
      `- Engine wait p50/p99: ${s.engineWaitMs.p50} / ${s.engineWaitMs.p99} ms; process p50/p99: ${s.engineProcessMs.p50} / ${s.engineProcessMs.p99} ms`,
      `- cgroup memory: max ${s.cgroupMemoryMb.max} MB; OOM kills ${s.cgroupOomKills}`,
      `- WebSocket connections max ${s.wsConnections.max}; subscriptions by topic (max): ${Object.entries(s.wsSubscriptions).map(([k, v]) => `${k} ${v.max}`).join(", ")}`,
      `- Watched projects max ${s.watchedProjects.max}`,
      "",
      "| Group | RSS mean MB | RSS max MB | CPU cores | peak processes |",
      "| --- | --- | --- | --- | --- |",
      ...Object.keys(s.rssMbByGroup).map(
        (g) => `| ${g} | ${s.rssMbByGroup[g].mean ?? ""} | ${s.rssMbByGroup[g].max ?? ""} | ${s.cpuCoresByGroup[g]} | ${s.peakProcessesByGroup[g]} |`,
      ),
      "",
      `Web requests: ${Object.entries(s.webRequests).map(([k, v]) => `${k.match(/class="([^"]+)"/)?.[1]} ${v}`).join(", ")}`,
      "",
      `Bootstrap requests: ${Object.entries(s.bootstrapRequests).map(([k, v]) => `${k.match(/caller="([^"]+)"/)?.[1]} ${v}`).join(", ")}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}
