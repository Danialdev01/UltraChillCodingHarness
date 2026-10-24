#!/usr/bin/env node
/**
 * One member's tab on a chat page, in a real browser, from seeded users
 * (load-out/sessions.json):
 *
 *   1. its WebSockets, and the subscriptions open on each once it settles;
 *   2. what it re-renders when another member saves a project setting --
 *      the preview port, which publishes `resource.changed` with
 *      `project_settings` and makes every other tab call `router.refresh()`.
 *
 *   node scripts/load/probes/tab.mjs [--sessions load-out/sessions.json]
 *     [--viewer 1] [--saver 0] [--settle 40] [--watch 30]
 *
 * Requests are counted from the tab itself: RSC renders (`rsc: 1`, split
 * into prefetches and the rest) and API calls.
 * Needs Chrome: E2E_CHROME (default /opt/google/chrome/chrome).
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    sessions: { type: "string", default: "load-out/sessions.json" },
    viewer: { type: "string", default: "1" },
    saver: { type: "string", default: "0" },
    settle: { type: "string", default: "40" },
    watch: { type: "string", default: "30" },
  },
});

const seeded = JSON.parse(await readFile(args.sessions, "utf8"));
const base = seeded.base;
const viewer = seeded.users[Number(args.viewer)];
const saver = seeded.users[Number(args.saver)];
const get = async (path, cookie) => (await fetch(`${base}${path}`, { headers: { cookie } })).json();

const first = await get("/api/bootstrap", viewer.cookie);
const shared = first.workspaces.find((w) => w.id === seeded.sharedWorkspaceId);
const { projects } = await get(`/api/bootstrap?ws=${shared.hash}&hint=${shared.id}`, viewer.cookie);
const project = projects[0];

const require = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROME ?? "/opt/google/chrome/chrome" });
const context = await browser.newContext();
await context.addCookies([
  { name: "ucch_session", value: viewer.cookie.split("=")[1], domain: new URL(base).hostname, path: "/" },
]);
const page = await context.newPage();

// Subscriptions per socket, from the frames the tab sends.
const sockets = [];
page.on("websocket", (ws) => {
  const socket = { url: ws.url().replace(/ticket=[^&]+/, "ticket=…"), topics: new Set(), closed: false };
  sockets.push(socket);
  ws.on("framesent", ({ payload }) => {
    let frame;
    try {
      frame = JSON.parse(String(payload));
    } catch {
      return;
    }
    const key = frame.topic ? JSON.stringify(frame.topic) : null;
    if (frame.kind === "subscribe" && key) socket.topics.add(key);
    if (frame.kind === "unsubscribe" && key) socket.topics.delete(key);
  });
  ws.on("close", () => (socket.closed = true));
});

const counts = { rsc: 0, rscPrefetch: 0, api: 0 };
let counting = false;
page.on("request", (request) => {
  if (!counting) return;
  const headers = request.headers();
  if (headers.rsc === "1") counts[headers["next-router-prefetch"] ? "rscPrefetch" : "rsc"]++;
  else if (new URL(request.url()).pathname.startsWith("/api/")) counts.api++;
});

await page.goto(`${base}/${shared.hash}/p/${project.hash}`);
await page.waitForTimeout(Number(args.settle) * 1000);
const open = sockets.filter((s) => !s.closed);
const topicsByKind = (socket) => {
  const byKind = {};
  for (const key of socket.topics) {
    const name = JSON.parse(key).name;
    byKind[name] = (byKind[name] ?? 0) + 1;
  }
  return byKind;
};
const tab = {
  path: new URL(page.url()).pathname,
  socketsOpened: sockets.length,
  socketsOpen: open.length,
  subscriptions: open.map((s) => ({ total: s.topics.size, byKind: topicsByKind(s) })),
  projectsInWorkspace: projects.length,
};

// Another member saves a setting of a project in the workspace.
counting = true;
const current = projects[1] ?? project;
const response = await fetch(`${base}/api/projects/${current.hash}/preview`, {
  method: "PUT",
  headers: { cookie: saver.cookie, origin: base, "content-type": "application/json" },
  body: JSON.stringify({ port: current.previewPort === 5173 ? 5174 : 5173 }),
});
await page.waitForTimeout(Number(args.watch) * 1000);
counting = false;

console.log(
  JSON.stringify({ tab, settingsSave: { status: response.status, watchSeconds: Number(args.watch), requests: counts } }),
);
await browser.close();
