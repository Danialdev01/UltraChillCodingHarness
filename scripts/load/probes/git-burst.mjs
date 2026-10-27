#!/usr/bin/env node
/**
 * What one burst of file changes costs in git processes while --viewers
 * people have the project's Git view open.
 *
 *   node scripts/load/probes/git-burst.mjs [--sessions load-out/sessions.json]
 *     [--viewers 10] [--files 20] [--container ucch-load] [--metrics-token T]
 *
 * Each viewer does what `components/git/use-git-state.ts` does: a quiet
 * subscription to the project topic that holds its file watcher
 * (`files: true`), a first read of status, branches and the first log page,
 * and the same reads again -- status, then the other two -- on every
 * `resource.changed{git}`, `git.committed` or `git.pushed`. Each read sends
 * the ETag it last got back, as the browser revalidates a `no-cache`
 * response, and counts the 304s. The burst is --files files
 * written into the project's checkout inside the container, 20 ms apart,
 * as an agent writes them. The count is the server's own
 * (`git_processes_total`, read from /metrics), from just before the burst
 * to 5 s after it.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    sessions: { type: "string", default: "load-out/sessions.json" },
    viewers: { type: "string", default: "10" },
    files: { type: "string", default: "20" },
    container: { type: "string", default: "ucch-load" },
    "metrics-token": { type: "string", default: process.env.METRICS_TOKEN ?? "" },
  },
});

const seeded = JSON.parse(await readFile(args.sessions, "utf8"));
const base = seeded.base;
const viewers = seeded.users.slice(0, Number(args.viewers));

async function gitCount() {
  const response = await fetch(`${base}/metrics`, {
    headers: args["metrics-token"] ? { authorization: `Bearer ${args["metrics-token"]}` } : {},
  });
  if (!response.ok) throw new Error(`/metrics: ${response.status}`);
  const byCommand = {};
  for (const m of (await response.text()).matchAll(/^git_processes_total\{command="([^"]+)"\} (\d+)/gm)) {
    byCommand[m[1]] = Number(m[2]);
  }
  return byCommand;
}

const first = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie: viewers[0].cookie } })).json();
const shared = first.workspaces.find((w) => w.id === seeded.sharedWorkspaceId);
const { projects } = await (
  await fetch(`${base}/api/bootstrap?ws=${shared.hash}&hint=${shared.id}`, { headers: { cookie: viewers[0].cookie } })
).json();
const project = projects[0];
const git = `${base}/api/projects/${project.hash}/git`;

let refreshes = 0;
let notModified = 0;
const sockets = await Promise.all(
  viewers.map(async (user) => {
    const etags = new Map();
    const read = async (url) => {
      const etag = etags.get(url);
      const response = await fetch(url, { headers: { cookie: user.cookie, ...(etag ? { "if-none-match": etag } : {}) } });
      await response.arrayBuffer();
      if (response.status === 304) notModified++;
      if (response.headers.get("etag")) etags.set(url, response.headers.get("etag"));
    };
    const refresh = async () => {
      refreshes++;
      await read(`${git}/status`);
      await Promise.all([read(`${git}/branches`), read(`${git}/log?skip=0&limit=50`)]);
    };
    const ticket = await fetch(`${base}/api/ws-ticket`, { method: "POST", headers: { cookie: user.cookie, origin: base } });
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?ticket=${(await ticket.json()).ticket}`);
    ws.addEventListener("message", (message) => {
      const frame = JSON.parse(String(message.data));
      if (frame.kind !== "push" || frame.event.projectId !== project.id) return;
      const { type, resource } = frame.event;
      if (!(type === "resource.changed" && resource === "git") && type !== "git.committed" && type !== "git.pushed") return;
      void refresh();
    });
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    ws.send(
      JSON.stringify({
        kind: "subscribe",
        id: "s",
        topic: { name: "project", projectId: project.id, quiet: true, files: true },
      }),
    );
    await refresh();
    return ws;
  }),
);
// A watch that starts fresh invalidates the git cache once: let that settle.
await new Promise((resolve) => setTimeout(resolve, 3000));
const mounted = refreshes;
const mountedNotModified = notModified;

const before = await gitCount();
execFileSync("docker", [
  "exec",
  "-u",
  "node",
  args.container,
  "sh",
  "-c",
  `cd /data/workspaces/${project.id} && for i in $(seq 1 ${Number(args.files)}); do echo "change $i $(date +%s%N)" > burst-$i.txt; sleep 0.02; done`,
]);
await new Promise((resolve) => setTimeout(resolve, 5000));
const after = await gitCount();
const delta = {};
for (const command of new Set([...Object.keys(before), ...Object.keys(after)])) {
  const n = (after[command] ?? 0) - (before[command] ?? 0);
  if (n) delta[command] = n;
}
for (const ws of sockets) ws.close();
console.log(
  JSON.stringify({
    viewers: viewers.length,
    files: Number(args.files),
    refreshesAfterBurst: refreshes - mounted,
    notModifiedAfterBurst: notModified - mountedNotModified,
    gitProcesses: Object.values(delta).reduce((a, b) => a + b, 0),
    byCommand: delta,
  }),
);
process.exit(0);
