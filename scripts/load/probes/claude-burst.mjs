#!/usr/bin/env node
/**
 * A burst of Claude Code turns at once, from seeded users: how many `claude`
 * processes run together, and how many turns fail.
 *
 *   node scripts/load/probes/claude-burst.mjs [--sessions load-out/sessions.json]
 *     [--turns 20] [--container ucch-load] [--timeout 180]
 *
 * Each user sends two at once (AGENT_MAX_CONCURRENT_PER_USER's default), so
 * --turns 20 is ten users. The turns run on fake-claude.mjs (CLAUDE_BIN, set
 * by up.sh). procwatch.mjs counts the processes inside the container.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    sessions: { type: "string", default: "load-out/sessions.json" },
    turns: { type: "string", default: "20" },
    container: { type: "string", default: "ucch-load" },
    timeout: { type: "string", default: "180" },
  },
});

const seeded = JSON.parse(await readFile(args.sessions, "utf8"));
const base = seeded.base;
const turns = Number(args.turns);
const users = seeded.users.slice(0, Math.ceil(turns / 2));

/** A socket whose acked commands resolve with their answer, and whose pushes go to `onPush`. */
async function connect(cookie, onPush) {
  const ticket = await fetch(`${base}/api/ws-ticket`, { method: "POST", headers: { cookie, origin: base } });
  if (!ticket.ok) throw new Error(`ws-ticket ${ticket.status}`);
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?ticket=${(await ticket.json()).ticket}`);
  const pending = new Map();
  let next = 0;
  ws.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data));
    if (frame.kind === "push") onPush(frame.event);
    else if (pending.has(frame.id)) {
      pending.get(frame.id)(frame);
      pending.delete(frame.id);
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("socket error")), { once: true });
  });
  const request = (frame) =>
    new Promise((resolve) => {
      const id = `b${++next}`;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ ...frame, id }));
    });
  return { ws, request };
}

const first = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie: users[0].cookie } })).json();
const shared = first.workspaces.find((w) => w.id === seeded.sharedWorkspaceId);
const { projects } = await (
  await fetch(`${base}/api/bootstrap?ws=${shared.hash}&hint=${shared.id}`, { headers: { cookie: users[0].cookie } })
).json();

const outcome = new Map();
const prepared = [];
for (const [i, user] of users.entries()) {
  const socket = await connect(user.cookie, (event) => {
    if (!outcome.has(event.threadId)) return;
    if (event.type === "agent.turn_completed" || event.type === "agent.turn_failed") {
      if (outcome.get(event.threadId) === "running") {
        outcome.set(event.threadId, event.type === "agent.turn_completed" ? "completed" : "failed");
      }
    }
  });
  for (let k = 0; k < 2 && prepared.length < turns; k++) {
    const created = await socket.request({
      kind: "dispatch",
      command: { type: "thread.create", projectId: projects[i % projects.length].id, title: `claude burst ${i}.${k}` },
    });
    const threadId = created.events?.find((e) => e.event.type === "thread.created")?.event.threadId;
    if (!threadId) throw new Error(`thread.create: ${created.code} ${created.message}`);
    await socket.request({ kind: "subscribe", topic: { name: "thread", threadId } });
    prepared.push({ socket, threadId });
  }
}

const watcher = spawn(
  "docker",
  ["exec", args.container, "node", "/load/probes/procwatch.mjs", "--seconds", String(Number(args.timeout) + 5)],
  { stdio: ["ignore", "pipe", "inherit"] },
);
let watched = "";
watcher.stdout.on("data", (chunk) => (watched += chunk));
await new Promise((resolve) => setTimeout(resolve, 1000));

const started = Date.now();
const acks = await Promise.all(
  prepared.map(({ socket, threadId }) => {
    outcome.set(threadId, "running");
    return socket.request({
      kind: "dispatch",
      command: { type: "thread.send", threadId, text: "Explain what you would change.", provider: "claude" },
    });
  }),
);
acks.forEach((ack, i) => {
  if (ack.kind !== "ack") outcome.set(prepared[i].threadId, `refused: ${ack.code}`);
});

const deadline = started + Number(args.timeout) * 1000;
while ([...outcome.values()].includes("running") && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 250));
}
const seconds = (Date.now() - started) / 1000;
// procwatch prints its running totals every second; the last line is the burst's.
watcher.kill("SIGINT");
await new Promise((resolve) => watcher.on("close", resolve));
const tally = {};
for (const value of outcome.values()) tally[value] = (tally[value] ?? 0) + 1;
for (const { socket } of prepared) socket.ws.close();
console.log(
  JSON.stringify({
    turns,
    users: users.length,
    seconds: Math.round(seconds * 10) / 10,
    outcomes: tally,
    processes: watched.trim() ? JSON.parse(watched.trim().split("\n").at(-1)) : null,
  }),
);
process.exit(0);
