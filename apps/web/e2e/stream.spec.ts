import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * What a streaming answer costs the page, measured while it streams:
 *
 *   long tasks      PerformanceObserver("longtask"): how often, and how
 *                   long, the main thread was blocked
 *   INP             the slowest interaction (Event Timing, grouped by
 *                   interactionId) among the keys pressed during the stream
 *   frame-to-paint  a delta's arrival on the socket -> the end of the next
 *                   frame painted after it (rAF, then a task after paint)
 *   frame gaps      the time between animation frames
 *   received        frames and bytes on all the tab's sockets, send to done
 *   kept            whether the message sent is still on screen once the
 *                   answer is done: a long answer used to push it out
 *
 * It opens a new session in the first project it can see and sends one
 * message, so the server must stream from the load-test mocks
 * (scripts/load/README.md): `OPENROUTER_BASE_URL` at mock-openrouter.mjs and
 * `CLAUDE_BIN` at fake-claude.mjs. Against the load-test container:
 *
 *   E2E_BASE_URL=http://127.0.0.1:3397 E2E_API=http://127.0.0.1:3397 \
 *   E2E_SESSION=<a cookie value from load-out/sessions.json> \
 *     pnpm --filter @ucch/web exec playwright test stream
 *
 * `E2E_CPU_THROTTLE=4` slows the page's CPU fourfold (Chrome's own
 * throttling), closer to a mid-range laptop than the machine running this.
 *
 * Results go to `e2e/results/stream-<E2E_LABEL or "latest">.json`.
 */

const API = process.env.E2E_API ?? "http://127.0.0.1:3001";
const COOKIE = process.env.E2E_SESSION ?? "dev";
const RESULTS = join(dirname(fileURLToPath(import.meta.url)), "results");

type Json = Record<string, any>;

async function api(path: string): Promise<Json> {
  const response = await fetch(`${API}${path}`, { headers: { cookie: `ucch_session=${COOKIE}` } });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json() as Promise<Json>;
}

/** A new thread in the first project, made over the socket as the app makes one. */
async function newThread(origin: string): Promise<{ href: string; threadId: string }> {
  const { workspaces } = await api("/api/workspaces");
  let found: { ws: Json; project: Json } | null = null;
  for (const ws of workspaces.filter((w: Json) => w.kind === "project" && !w.archived)) {
    const { projects } = await api(`/api/workspaces/${ws.id}/projects`);
    if (projects.length) {
      found = { ws, project: projects[0] };
      break;
    }
  }
  if (!found) throw new Error("no project to stream in: create one first");

  const ticket = await fetch(`${API}/api/ws-ticket`, {
    method: "POST",
    headers: { cookie: `ucch_session=${COOKIE}`, origin },
  });
  if (!ticket.ok) throw new Error(`ws-ticket: ${ticket.status}`);
  const socket = new WebSocket(`${API.replace(/^http/, "ws")}/ws?ticket=${(await ticket.json()).ticket}`);
  const ack = await new Promise<Json>((resolve, reject) => {
    socket.addEventListener("error", () => reject(new Error("socket error")), { once: true });
    socket.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data)) as Json;
      if (frame.id === "stream-spec") resolve(frame);
    });
    socket.addEventListener(
      "open",
      () =>
        socket.send(
          JSON.stringify({
            kind: "dispatch",
            id: "stream-spec",
            command: { type: "thread.create", projectId: found.project.id, title: `stream spec ${new Date().toISOString()}` },
          }),
        ),
      { once: true },
    );
  });
  socket.close();
  const threadId = ack.events?.find((e: Json) => e.event.type === "thread.created")?.event.threadId as string | undefined;
  if (ack.kind !== "ack" || !threadId) throw new Error(`thread.create: ${ack.code} ${ack.message}`);
  const { threads } = await api(`/api/projects/${found.project.hash}/threads`);
  const thread = threads.find((t: Json) => t.id === threadId);
  return { href: `/${found.ws.hash}/p/${found.project.hash}/${thread.hash}`, threadId };
}

test("streaming cost", async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const { href, threadId } = await newThread(origin);
  await context.addCookies([{ name: "ucch_session", value: COOKIE, domain: new URL(baseURL!).hostname, path: "/" }]);

  // Installed before the app's own code: the observers, and a tap on every
  // socket that notes when a delta for this thread arrives and when the
  // frame after it was painted.
  await page.addInitScript((thread) => {
    const w = window as any;
    const perf = (w.__streamPerf = {
      recording: false,
      longTasks: [] as { start: number; duration: number }[],
      events: [] as { name: string; id: number; start: number; duration: number }[],
      deltas: [] as { received: number; painted: number }[],
      frames: [] as number[],
      socketFrames: 0,
      socketBytes: 0,
      firstDelta: -1,
      done: -1,
      outcome: "",
    });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (e.interactionId) perf.events.push({ name: e.name, id: e.interactionId, start: e.startTime, duration: e.duration });
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);

    // One rAF and one after-paint task per frame, however many deltas it carries.
    let waiting: { received: number; painted: number }[] = [];
    const afterPaint = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        const painted = performance.now();
        for (const d of waiting) d.painted = painted;
        waiting = [];
      };
      channel.port2.postMessage(null);
    };
    const Native = window.WebSocket;
    w.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (message: MessageEvent) => {
          const data = String(message.data);
          // Every frame on every socket of the tab, not just this thread's.
          if (perf.recording && perf.done < 0) {
            perf.socketFrames++;
            perf.socketBytes += data.length;
          }
          if (!perf.recording || !data.includes(thread)) return;
          if (data.includes('"agent.text_delta"')) {
            const received = performance.now();
            if (perf.firstDelta < 0) perf.firstDelta = received;
            const delta = { received, painted: -1 };
            perf.deltas.push(delta);
            if (waiting.length === 0) requestAnimationFrame(afterPaint);
            waiting.push(delta);
          } else if (data.includes('"agent.turn_completed"') || data.includes('"agent.turn_failed"')) {
            perf.done = performance.now();
            perf.outcome = data.includes('"agent.turn_completed"') ? "completed" : "failed";
          }
        });
      }
    };
    const tick = (t: number) => {
      if (perf.recording && perf.done < 0) perf.frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, threadId);

  const throttle = Number(process.env.E2E_CPU_THROTTLE ?? 1);
  if (throttle > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  await page.goto(href);
  const composer = page.locator("textarea[role=combobox]");
  await expect(composer).toBeEnabled({ timeout: 30_000 });
  // Past the boot screen and the warmup behind it (CLAUDE.md, "The whole app loads at boot").
  await page.waitForTimeout(Number(process.env.E2E_IDLE_MS ?? 8000));
  const ASK = "Explain what you would change.";
  await composer.fill(ASK);

  const sentAt = await page.evaluate(() => {
    (window as any).__streamPerf.recording = true;
    return performance.now();
  });
  await composer.press("Enter");
  await page.waitForFunction(() => (window as any).__streamPerf.firstDelta >= 0, null, { timeout: 30_000 });

  // A reader reading as it streams: the composer is shut while the agent
  // works, so the keys go to the page -- each press is an interaction.
  const keys = ["ArrowUp", "ArrowDown", "PageUp", "PageDown"];
  let presses = 0;
  while (!(await page.evaluate(() => (window as any).__streamPerf.done >= 0))) {
    await page.keyboard.press(keys[presses++ % keys.length]!);
    await page.waitForTimeout(500);
    if (presses > 600) throw new Error("the answer did not finish in five minutes");
  }
  await page.waitForTimeout(500);
  const kept = (await page.getByText(ASK, { exact: true }).count()) > 0;

  const raw = await page.evaluate(() => (window as any).__streamPerf);
  const from = raw.firstDelta as number;
  const to = raw.done as number;
  const within = (t: number) => t >= from && t <= to;
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => Math.round((sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? -1) * 10) / 10;
    return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) };
  };

  const longTasks = (raw.longTasks as { start: number; duration: number }[]).filter((t) => within(t.start));
  const interactions = new Map<number, number>();
  for (const e of raw.events as { id: number; start: number; duration: number }[]) {
    if (within(e.start)) interactions.set(e.id, Math.max(interactions.get(e.id) ?? 0, e.duration));
  }
  const durations = [...interactions.values()].sort((a, b) => b - a);
  const frames = raw.frames as number[];
  const gaps = frames.slice(1).map((t, i) => t - frames[i]!);
  const result = {
    at: new Date().toISOString(),
    baseURL,
    cpuThrottle: throttle,
    outcome: raw.outcome,
    streamMs: Math.round(to - from),
    firstDeltaMs: Math.round(from - sentAt),
    deltas: raw.deltas.length,
    received: { frames: raw.socketFrames, bytes: raw.socketBytes },
    kept,
    longTasks: {
      count: longTasks.length,
      totalMs: Math.round(longTasks.reduce((sum, t) => sum + t.duration, 0)),
      maxMs: Math.round(Math.max(0, ...longTasks.map((t) => t.duration))),
    },
    // As web-vitals reckons it: the slowest, skipping one per 50 interactions.
    inp: {
      interactions: presses,
      measured: durations.length,
      ms: Math.round(durations[Math.min(durations.length - 1, Math.floor(presses / 50))] ?? 0),
    },
    frameToPaintMs: stats((raw.deltas as { received: number; painted: number }[]).filter((d) => d.painted >= 0).map((d) => d.painted - d.received)),
    frameGapMs: { ...stats(gaps), over50: gaps.filter((g) => g > 50).length },
  };
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, `stream-${process.env.E2E_LABEL ?? "latest"}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  expect(raw.outcome).toBe("completed");
  expect(result.frameToPaintMs.count).toBeGreaterThan(0);
});
