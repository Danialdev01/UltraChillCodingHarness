import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMemory, memoryStats, sqlite } from "./omp-memory.js";
import { registerOmpMemoryRoutes } from "./omp-memory-routes.js";

const { DatabaseSync } = sqlite();
const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "22222222-2222-2222-2222-222222222222";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const ADMIN = "admin";
const MEMBER = "member";
const STRANGER = "stranger";

/** A bank with mnemopi's two tables as 18.14.1 writes them, trimmed to the columns read here. */
function writeBank(path: string, rows: { type: string; at: string }[], episodic = 0) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("create table working_memory (id text primary key, content text not null, timestamp text, memory_type text default 'unknown')");
  db.exec("create table episodic_memory (rowid integer primary key autoincrement, id text unique not null, content text not null)");
  rows.forEach((row, i) => db.prepare("insert into working_memory values (?, ?, ?, ?)").run(`m${i}`, "x", row.at, row.type));
  for (let i = 0; i < episodic; i++) db.prepare("insert into episodic_memory (id, content) values (?, ?)").run(`e${i}`, "y");
  db.close();
}

describe("the memory card's routes (OM7.3)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-omp-memory-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const dbFor = (subject: string, projectId: string) => join(root, subject, "omp", "memories", projectId, "mnemopi.db");

  async function server() {
    const app = Fastify();
    await app.register(cookie);
    registerOmpMemoryRoutes(app, {
      principalFor: async (cookies) => (cookies.who ? { userId: cookies.who } : null),
      subjectFor: async (userId, workspaceId, permission) => {
        if (!workspaceId) return userId;
        if (workspaceId !== WS) return null;
        if (userId === ADMIN) return `ws-${WS}`;
        return userId === MEMBER && permission === "workspace.view" ? `ws-${WS}` : null;
      },
      visibleProject: async (projectId, userId) => (projectId === PROJECT && userId !== STRANGER ? { workspaceId: WS } : null),
      memoryDb: dbFor,
    });
    return app;
  }
  const as = (userId: string) => ({ cookie: `who=${userId}` });

  it("counts a project's facts and episodes, and says when there is no bank yet", async () => {
    const app = await server();
    const empty = await app.inject({ method: "GET", url: `/api/omp-memory/${PROJECT}`, headers: as(MEMBER) });
    expect(empty.json()).toEqual({ exists: false, facts: 0, episodes: 0, total: 0, bytes: 0, lastAt: null });
    writeBank(dbFor(MEMBER, PROJECT), [
      { type: "fact", at: "2026-11-01T10:00:00.000Z" },
      { type: "fact", at: "2026-11-02T09:00:00.000Z" },
      { type: "episode", at: "2026-11-01T11:00:00.000Z" },
    ], 2);
    const res = await app.inject({ method: "GET", url: `/api/omp-memory/${PROJECT}`, headers: as(MEMBER) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exists: true, facts: 2, episodes: 1, total: 5, lastAt: "2026-11-02T09:00:00.000Z" });
    expect(res.json().bytes).toBeGreaterThan(0);
  });

  it("reads the workspace's bank with ?workspace=, for its own projects only", async () => {
    const app = await server();
    writeBank(dbFor(`ws-${WS}`, PROJECT), [{ type: "fact", at: "2026-11-02T09:00:00.000Z" }]);
    const res = await app.inject({ method: "GET", url: `/api/omp-memory/${PROJECT}?workspace=${WS}`, headers: as(MEMBER) });
    expect(res.json()).toMatchObject({ facts: 1 });
    const foreign = await app.inject({ method: "GET", url: `/api/omp-memory/${PROJECT}?workspace=${OTHER_WS}`, headers: as(ADMIN) });
    expect(foreign.statusCode).toBe(404);
  });

  it("clears a bank: the caller's own, or the workspace's for an admin only", async () => {
    const app = await server();
    const own = dbFor(MEMBER, PROJECT);
    writeBank(own, [{ type: "fact", at: "2026-11-02T09:00:00.000Z" }]);
    writeFileSync(`${own}-wal`, "");
    const cleared = await app.inject({ method: "DELETE", url: `/api/omp-memory/${PROJECT}`, headers: as(MEMBER) });
    expect(cleared.statusCode).toBe(204);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(`${own}-wal`)).toBe(false);

    const shared = dbFor(`ws-${WS}`, PROJECT);
    writeBank(shared, [{ type: "fact", at: "2026-11-02T09:00:00.000Z" }]);
    const refused = await app.inject({ method: "DELETE", url: `/api/omp-memory/${PROJECT}?workspace=${WS}`, headers: as(MEMBER) });
    expect(refused.statusCode).toBe(403);
    expect(existsSync(shared)).toBe(true);
    const ok = await app.inject({ method: "DELETE", url: `/api/omp-memory/${PROJECT}?workspace=${WS}`, headers: as(ADMIN) });
    expect(ok.statusCode).toBe(204);
    expect(existsSync(shared)).toBe(false);
  });

  it("refuses without a session, for a project the caller cannot see, and for an id that is not one", async () => {
    const app = await server();
    expect((await app.inject({ method: "GET", url: `/api/omp-memory/${PROJECT}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/omp-memory/${PROJECT}`, headers: as(STRANGER) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/omp-memory/..%2F..%2Fetc", headers: as(MEMBER) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/omp-memory/${PROJECT}`, headers: as(STRANGER) })).statusCode).toBe(404);
  });
});

describe("memoryStats / clearMemory", () => {
  it("reads a bank without the tables as empty, and clearing nothing is fine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ucch-omp-memory-"));
    try {
      const path = join(dir, "mnemopi.db");
      new DatabaseSync(path).close();
      expect(await memoryStats(path)).toMatchObject({ exists: true, facts: 0, episodes: 0, total: 0, lastAt: null });
      await clearMemory(path);
      await clearMemory(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
