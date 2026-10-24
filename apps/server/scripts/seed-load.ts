/**
 * Seeds a load-test database: users, a shared workspace, sessions and
 * projects, so `scripts/load/run.mjs` has people to be.
 *
 *   LOADTEST_ALLOW_SEED=1 DATABASE_URL=postgres://.../ucch_load SECRET_KEY=<64 hex> \
 *     pnpm --filter @ucch/server exec tsx scripts/seed-load.ts \
 *       --users 50 --projects 20 --url http://127.0.0.1:3000
 *
 * Writes `$LOAD_OUT/sessions.json` (default `./load-out`): one
 * `{ userId, email, cookie, personalWorkspaceId }` per user, plus the shared
 * workspace's id.
 *
 * - **Guarded.** It refuses to run without `LOADTEST_ALLOW_SEED=1`, or
 *   against a database whose name does not end in `_load`: it creates fifty
 *   accounts with a known password, which must never happen to a real one.
 * - **Real credentials.** Passwords are hashed as sign-up hashes them, the
 *   dummy OpenRouter key is encrypted with `SECRET_KEY` as Settings stores
 *   it, and sessions are made by `AuthService.createSession` -- not through
 *   `/api/auth/login`, which allows 20 sign-ins a minute per address.
 * - **Real projects.** Each is made by a `project.create` over the server's
 *   WebSocket, as the browser makes one, so the engine and the clone reactor
 *   run (no `repoUrl`, so the repositories start empty). The server at
 *   `--url` must use this same database and `SECRET_KEY`.
 * - **Re-runnable.** Users are found by email, and a workspace that already
 *   has its projects gets no more, so a second run only fills gaps.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDatabase, events, projects, users, workspaceMembers, workspaces } from "@ucch/db";
import { AuthService } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { encryptSecret } from "../src/crypto.js";
import { WorkspaceService } from "../src/workspaces.js";

const { values: args } = parseArgs({
  options: {
    users: { type: "string", default: "50" },
    projects: { type: "string", default: "20" },
    url: { type: "string", default: "http://127.0.0.1:3000" },
    password: { type: "string", default: "load-password-123" },
    "clone-timeout": { type: "string", default: "120" },
  },
});

const fail = (message: string): never => {
  console.error(`seed-load: ${message}`);
  process.exit(1);
};

const userCount = Number(args.users);
const projectCount = Number(args.projects);
if (!Number.isInteger(userCount) || userCount < 1) fail("--users must be a positive integer");
if (!Number.isInteger(projectCount) || projectCount < 0) fail("--projects must be zero or more");

if (process.env.LOADTEST_ALLOW_SEED !== "1") fail("set LOADTEST_ALLOW_SEED=1 to seed a load-test database");
const databaseUrl = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set");
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
if (!databaseName.endsWith("_load")) fail(`refusing to seed "${databaseName}": the database name must end in _load`);
const secretKey = process.env.SECRET_KEY ?? "";
if (!/^[0-9a-f]{64}$/i.test(secretKey)) fail("SECRET_KEY must be the server's 64 hex characters");

const base = args.url.replace(/\/+$/, "");
const out = resolve(process.env.LOAD_OUT ?? "load-out");
const started = performance.now();
const db = createDatabase(databaseUrl);
// A seeded session must be a real one: AuthService reads nothing from its
// config but the development bypass, which stays off.
const auth = new AuthService(db, { DEV_AUTH_BYPASS: false } as Config);
const workspaceService = new WorkspaceService(db);

/** Runs `task` over `items`, `limit` at a time. */
async function pool<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index]!, index);
      }
    }),
  );
  return results;
}

// -- Users, their keys and their own workspaces ------------------------------

const seeded = await pool(
  Array.from({ length: userCount }, (_, i) => i),
  8,
  async (i) => {
    const email = `load-${String(i).padStart(3, "0")}@load.test`;
    const { id } = await auth.ensurePasswordUser({
      email,
      password: args.password,
      login: `load${i}`,
      name: `Load User ${i}`,
    });
    await db
      .update(users)
      .set({ openrouterKeyEncrypted: encryptSecret(`sk-or-v1-load-${i}`, secretKey) })
      .where(eq(users.id, id));
    const personal = await workspaceService.ensureDefault(id);
    const session = await auth.createSession(id, ["read", "write", "exec", "admin"]);
    return { userId: id, email, cookie: `ucch_session=${session}`, personalWorkspaceId: personal.id };
  },
);
console.log(`users: ${seeded.length}`);

// -- The shared workspace ----------------------------------------------------

const owner = seeded[0]!;
const SHARED = "Load shared";
const [existingShared] = await db
  .select({ id: workspaces.id })
  .from(workspaces)
  .where(and(eq(workspaces.ownerUserId, owner.userId), eq(workspaces.name, SHARED)))
  .limit(1);
let sharedWorkspaceId = existingShared?.id;
if (!sharedWorkspaceId) {
  const created = await workspaceService.create(owner.userId, SHARED);
  if ("conflict" in created) fail("could not create the shared workspace");
  else sharedWorkspaceId = created.id;
}
await db
  .insert(workspaceMembers)
  .values(seeded.slice(1).map((user) => ({ workspaceId: sharedWorkspaceId!, userId: user.userId, role: "member" })))
  .onConflictDoNothing();
console.log(`shared workspace: ${sharedWorkspaceId}, ${seeded.length} members`);

// -- Projects, through the server --------------------------------------------

/** One socket per creator; commands are acked in order, so one at a time. */
async function createProjects(cookie: string, workspaceId: string, missing: number, offset: number): Promise<string[]> {
  if (missing <= 0) return [];
  const ticketResponse = await fetch(`${base}/api/ws-ticket`, {
    method: "POST",
    headers: { cookie, origin: base },
  });
  if (!ticketResponse.ok) fail(`ws-ticket: ${ticketResponse.status} ${await ticketResponse.text()}`);
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/ws?ticket=${encodeURIComponent(ticket)}`);
  const pending = new Map<string, (frame: Record<string, any>) => void>();
  socket.addEventListener("message", (message) => {
    const frame = JSON.parse(String(message.data)) as Record<string, any>;
    if (typeof frame.id === "string") pending.get(frame.id)?.(frame);
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error(`could not open ${base}/ws`)), { once: true });
  });

  const ids: string[] = [];
  for (let i = 0; i < missing; i++) {
    const id = `seed-${i}`;
    const frame = await new Promise<Record<string, any>>((answer) => {
      pending.set(id, answer);
      socket.send(
        JSON.stringify({
          kind: "dispatch",
          id,
          command: { type: "project.create", workspaceId, name: `load-project-${offset + i + 1}` },
        }),
      );
    });
    pending.delete(id);
    if (frame.kind !== "ack") fail(`project.create: ${frame.code} ${frame.message}`);
    const created = (frame.events as Array<{ event: { type: string; projectId?: string } }>).find(
      (e) => e.event.type === "project.created",
    );
    if (created?.event.projectId) ids.push(created.event.projectId);
  }
  socket.close();
  return ids;
}

const targets = [
  { cookie: owner.cookie, workspaceId: sharedWorkspaceId! },
  ...seeded.map((user) => ({ cookie: user.cookie, workspaceId: user.personalWorkspaceId })),
];
const counts = await db
  .select({ workspaceId: projects.workspaceId, n: sql<number>`count(*)::int` })
  .from(projects)
  .where(inArray(projects.workspaceId, targets.map((t) => t.workspaceId)))
  .groupBy(projects.workspaceId);
const have = new Map(counts.map((row) => [row.workspaceId, Number(row.n)]));

const created = (
  await pool(targets, 8, (target) => {
    const existing = have.get(target.workspaceId) ?? 0;
    return createProjects(target.cookie, target.workspaceId, projectCount - existing, existing);
  })
).flat();
console.log(`projects created: ${created.length} (${projectCount} per workspace across ${targets.length})`);

// The clone reactor runs after the ack; wait for every new project to be cloned.
const deadline = Date.now() + Number(args["clone-timeout"]) * 1000;
for (;;) {
  const [row] = created.length
    ? await db
        .select({ n: sql<number>`count(distinct ${events.projectId})::int` })
        .from(events)
        .where(and(inArray(events.projectId, created), eq(events.type, "project.cloned")))
    : [{ n: 0 }];
  const cloned = Number(row?.n ?? 0);
  if (cloned >= created.length) break;
  if (Date.now() > deadline) fail(`only ${cloned} of ${created.length} projects were cloned in time`);
  await new Promise((wait) => setTimeout(wait, 250));
}

await mkdir(out, { recursive: true });
const file = join(out, "sessions.json");
await writeFile(
  file,
  `${JSON.stringify({ base, sharedWorkspaceId, password: args.password, users: seeded }, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`wrote ${file} in ${((performance.now() - started) / 1000).toFixed(1)} s`);
process.exit(0);
