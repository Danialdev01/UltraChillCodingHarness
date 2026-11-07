import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { Database } from "@ucch/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptSecret } from "./crypto.js";
import { registerEnvRoutes, WRONG_KEY_LIMIT } from "./env-routes.js";
import { EnvVarService } from "./env-vars.js";
import type { ProjectSummary } from "./workspaces.js";

const HASH = "abcdefghijkl";
const PROJECT = { id: "p1", hash: HASH } as ProjectSummary;
const SECRET = "11".repeat(32);
const KEY = "correct horse battery";

interface LegacyRow {
  id: string;
  projectId: string;
  name: string;
  valueEncrypted: string;
  tags: string[];
  url: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Just enough of drizzle for the legacy `project_keys` reads and deletes. */
function fakeDb(rows: LegacyRow[]) {
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [...rows] }) }) }),
    delete: () => ({
      where: async () => {
        // The service deletes one row per call, in order.
        rows.shift();
      },
    }),
  };
  return db as unknown as Database;
}

let root: string;
let legacy: LegacyRow[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-env-"));
  await mkdir(join(root, PROJECT.id, ".git"), { recursive: true });
  legacy = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function app(now = () => Date.now()) {
  const server = Fastify();
  registerEnvRoutes(server, {
    projectFor: async (request) => (request.params.hash === HASH ? PROJECT : null),
    userFor: async () => "u1",
    env: new EnvVarService(fakeDb(legacy), (id) => join(root, id), SECRET),
    now,
  });
  return server;
}

const base = `/api/projects/${HASH}/env`;

describe("environment variable routes", () => {
  it("stays disabled until the project key is set up", async () => {
    const server = app();
    expect((await server.inject({ url: base })).json()).toEqual({ configured: false, vars: [] });
    const refused = await server.inject({ method: "POST", url: `${base}/vars`, payload: { projectKey: KEY, name: "A", value: "1" } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("not_configured");
  });

  it("refuses a key before the clone has landed, which would delete the vault", async () => {
    const server = app();
    await rm(join(root, PROJECT.id, ".git"), { recursive: true });
    const early = await server.inject({ method: "POST", url: `${base}/project-key`, payload: { projectKey: KEY } });
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe("not_ready");
    await expect(stat(join(root, PROJECT.id, ".agent"))).rejects.toThrow();
  });

  it("sets a key up once, stores values only encrypted, and reveals them with the key", async () => {
    const server = app();
    const short = await server.inject({ method: "POST", url: `${base}/project-key`, payload: { projectKey: "short" } });
    expect(short.statusCode).toBe(400);
    expect((await server.inject({ method: "POST", url: `${base}/project-key`, payload: { projectKey: KEY } })).statusCode).toBe(201);
    expect((await server.inject({ method: "POST", url: `${base}/project-key`, payload: { projectKey: KEY } })).statusCode).toBe(409);

    const created = await server.inject({
      method: "POST",
      url: `${base}/vars`,
      payload: { projectKey: KEY, name: "OPENAI_API_KEY", value: "sk-secret", tags: ["openai", " openai "] },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().var.id as string;
    expect(created.json().var).toMatchObject({ name: "OPENAI_API_KEY", tags: ["openai"] });

    const file = await readFile(join(root, PROJECT.id, ".agent", "env.val"), "utf8");
    expect(file).toContain("OPENAI_API_KEY");
    expect(file).not.toContain("sk-secret");
    expect(file).not.toContain(KEY);

    const list = (await server.inject({ url: base })).json();
    expect(list.configured).toBe(true);
    expect(JSON.stringify(list)).not.toContain("sk-secret");

    const reveal = await server.inject({ method: "POST", url: `${base}/vars/${id}/reveal`, payload: { projectKey: KEY } });
    expect(reveal.json()).toEqual({ value: "sk-secret" });
    expect(reveal.headers["cache-control"]).toBe("no-store");

    const patched = await server.inject({ method: "PATCH", url: `${base}/vars/${id}`, payload: { projectKey: KEY, value: "sk-new" } });
    expect(patched.statusCode).toBe(200);
    expect((await server.inject({ method: "POST", url: `${base}/vars/${id}/reveal`, payload: { projectKey: KEY } })).json().value).toBe("sk-new");

    expect((await server.inject({ method: "DELETE", url: `${base}/vars/${id}`, payload: { projectKey: KEY } })).statusCode).toBe(204);
    expect((await server.inject({ url: base })).json().vars).toEqual([]);
  });

  it("refuses every value operation under a wrong key, then limits the guesses", async () => {
    let now = 1_000_000;
    const server = app(() => now);
    await server.inject({ method: "POST", url: `${base}/project-key`, payload: { projectKey: KEY } });
    const id = (await server.inject({ method: "POST", url: `${base}/vars`, payload: { projectKey: KEY, name: "A", value: "1" } })).json().var.id;

    for (const [method, url] of [
      ["POST", `${base}/unlock`],
      ["POST", `${base}/vars/${id}/reveal`],
      ["DELETE", `${base}/vars/${id}`],
    ] as const) {
      const wrong = await server.inject({ method, url, payload: { projectKey: "not the key" } });
      expect(wrong.statusCode).toBe(403);
    }
    expect((await server.inject({ url: base })).json().vars).toHaveLength(1);

    for (let i = 3; i < WRONG_KEY_LIMIT.max; i++) {
      await server.inject({ method: "POST", url: `${base}/unlock`, payload: { projectKey: "not the key" } });
    }
    const limited = await server.inject({ method: "POST", url: `${base}/unlock`, payload: { projectKey: KEY } });
    expect(limited.statusCode).toBe(429);
    now += WRONG_KEY_LIMIT.windowMs + 1;
    expect((await server.inject({ method: "POST", url: `${base}/unlock`, payload: { projectKey: KEY } })).statusCode).toBe(204);
  });

  it("changes the key, keeping the values, and resets when it is forgotten", async () => {
    const server = app();
    await server.inject({ method: "POST", url: `${base}/project-key`, payload: { projectKey: KEY } });
    const id = (await server.inject({ method: "POST", url: `${base}/vars`, payload: { projectKey: KEY, name: "A", value: "1" } })).json().var.id;

    expect((await server.inject({ method: "PUT", url: `${base}/project-key`, payload: { oldKey: "nope", newKey: "another key" } })).statusCode).toBe(403);
    expect((await server.inject({ method: "PUT", url: `${base}/project-key`, payload: { oldKey: KEY, newKey: "another key" } })).statusCode).toBe(204);
    expect((await server.inject({ method: "POST", url: `${base}/unlock`, payload: { projectKey: KEY } })).statusCode).toBe(403);
    expect((await server.inject({ method: "POST", url: `${base}/vars/${id}/reveal`, payload: { projectKey: "another key" } })).json().value).toBe("1");

    expect((await server.inject({ method: "DELETE", url: `${base}/project-key` })).statusCode).toBe(204);
    await expect(stat(join(root, PROJECT.id, ".agent", "env.val"))).rejects.toThrow();
    expect((await server.inject({ url: `${base}/project-key` })).json()).toEqual({ configured: false, legacyCount: 0 });
  });

  it("moves the keys saved before env.val into it when the key is set up", async () => {
    const at = new Date("2026-01-01T00:00:00Z");
    legacy.push({
      id: "00000000-0000-4000-8000-000000000001",
      projectId: PROJECT.id,
      name: "OLD_TOKEN",
      valueEncrypted: encryptSecret("legacy-value", SECRET),
      tags: ["old"],
      url: null,
      createdAt: at,
      updatedAt: at,
    });
    const server = app();
    expect((await server.inject({ url: `${base}/project-key` })).json()).toEqual({ configured: false, legacyCount: 1 });
    const setup = await server.inject({ method: "POST", url: `${base}/project-key`, payload: { projectKey: KEY } });
    expect(setup.json()).toEqual({ migrated: 1, skipped: 0 });
    expect(legacy).toHaveLength(0);
    const [moved] = (await server.inject({ url: base })).json().vars;
    expect(moved).toMatchObject({ name: "OLD_TOKEN", tags: ["old"] });
    const reveal = await server.inject({ method: "POST", url: `${base}/vars/${moved.id}/reveal`, payload: { projectKey: KEY } });
    expect(reveal.json().value).toBe("legacy-value");
  });

  it("is a 404 for a project the caller cannot see", async () => {
    const server = app();
    expect((await server.inject({ url: "/api/projects/zzzzzzzzzzzz/env" })).statusCode).toBe(404);
  });
});
