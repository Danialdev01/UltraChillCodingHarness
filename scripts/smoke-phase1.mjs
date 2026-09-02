/**
 * Phase 1 acceptance: a client connects, authenticates, and exchanges events.
 *
 * Run against a server booted with DEV_AUTH_BYPASS on port 3901:
 *   node scripts/smoke-phase1.mjs
 *   UCCH_BASE=https://api.ucch.danialirfan.dev node scripts/smoke-phase1.mjs
 */
import { WebSocket } from "ws";

// Target defaults to the local dev server; override to smoke a deployment:
//   UCCH_BASE=https://api.ucch.danialirfan.dev node scripts/smoke-phase1.mjs
const BASE = (process.env.UCCH_BASE ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const ok = (m) => console.log("  ok  ", m);

// 1. health
const health = await (await fetch(`${BASE}/health`)).json();
if (health.status !== "ok") fail("health");
ok(`health: ${JSON.stringify(health)}`);

// 2. identity
const me = await (await fetch(`${BASE}/api/me`)).json();
if (!me.userId) fail("me");
ok(`authenticated as ${me.userId} with scopes ${me.scopes.join(",")}`);

// 3. ws ticket
const { ticket } = await (await fetch(`${BASE}/api/ws-ticket`, { method: "POST" })).json();
if (!ticket) fail("no ticket issued");
ok(`ticket issued (${ticket.slice(0, 12)}...)`);

// 4. Ticket rejection is not asserted here: this server runs with
// DEV_AUTH_BYPASS, which authenticates every upgrade by design. The real
// ticket semantics (single-use, forgery, expiry) are covered with the bypass
// off in apps/server/src/auth.test.ts.

// 5. connect for real
const ws = new WebSocket(`${WS_BASE}/ws?ticket=${ticket}`);
const frames = [];
const waitFor = (pred, label) => new Promise((resolve, reject) => {
  const found = frames.find(pred);
  if (found) return resolve(found);
  const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 5000);
  const onMsg = (raw) => {
    const f = JSON.parse(raw.toString());
    if (pred(f)) { clearTimeout(t); ws.off("message", onMsg); resolve(f); }
  };
  ws.on("message", onMsg);
});
ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));

await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
ok("websocket connected");

const ready = await waitFor((f) => f.kind === "ready", "ready");
ok(`ready frame: user=${ready.userId} version=${ready.serverVersion}`);

// 6. heartbeat round-trip
ws.send(JSON.stringify({ kind: "ping", id: "p1" }));
const pong = await waitFor((f) => f.kind === "pong" && f.id === "p1", "pong");
ok(`heartbeat: pong at ${pong.serverTime}`);

// 7. a malformed frame is rejected without dropping the socket
ws.send("{not json");
await waitFor((f) => f.kind === "error" && f.code === "invalid", "invalid-frame error");
ok("malformed frame rejected, socket survived");

// 8. dispatch a real command through decide() -> event log -> projection
ws.send(JSON.stringify({
  kind: "dispatch",
  id: "c1",
  command: { type: "project.create", repoUrl: "https://github.com/laravel/laravel.git" },
}));
const ack = await waitFor((f) => (f.kind === "ack" && f.id === "c1") || (f.kind === "error" && f.id === "c1"), "ack");
if (ack.kind === "error") fail(`project.create: ${ack.code} ${ack.message}`);
const created = ack.events[0];
if (created?.event?.type !== "project.created") fail("no project.created event");
ok(`project.created: name=${created.event.name} hash=${created.event.hash} seq=${created.seq}`);

// 9. scope enforcement is per-command, not per-socket
ws.send(JSON.stringify({
  kind: "dispatch", id: "c2",
  command: { type: "project.start", projectId: "00000000-0000-4000-8000-0000000000ff" },
}));
const missing = await waitFor((f) => f.id === "c2", "not_found");
if (missing.kind !== "error" || missing.code !== "not_found") fail(`expected not_found, got ${JSON.stringify(missing)}`);
ok("unknown project reported as not_found");

// 10. subscribe to the new project's topic
ws.send(JSON.stringify({
  kind: "subscribe", id: "s1",
  topic: { name: "project", projectId: created.event.projectId },
}));
await waitFor((f) => f.kind === "ack" && f.id === "s1", "subscribe ack");
ok("subscribed to project topic");

// 11. a second command on that project must arrive as a live push
ws.send(JSON.stringify({
  kind: "dispatch", id: "c3",
  command: { type: "project.start", projectId: created.event.projectId },
}));
const push = await waitFor((f) => f.kind === "push" && f.event?.type === "container.state_changed", "push");
ok(`live push received: container.state_changed -> ${push.event.state}`);

ws.close();
console.log("\nAll Phase 1 checks passed.");
process.exit(0);
