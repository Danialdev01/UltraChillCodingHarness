import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerKeyRoutes } from "./keys-routes.js";
import type { ProjectKeyInput, ProjectKeyPatch, ProjectKeyRecord, ProjectKeyService } from "./keys.js";
import type { ProjectSummary } from "./workspaces.js";

const HASH = "abcdefghijkl";
const PROJECT = { id: "p1", hash: HASH } as ProjectSummary;

/** The service's contract, in memory: values held apart from the records. */
function fakeKeys() {
  const records = new Map<string, ProjectKeyRecord>();
  const values = new Map<string, string>();
  let next = 0;
  const service = {
    async list() {
      return [...records.values()];
    },
    async create(_projectId: string, input: ProjectKeyInput) {
      const id = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
      const now = new Date().toISOString();
      const record = { id, name: input.name, tags: input.tags ?? [], url: input.url || null, createdAt: now, updatedAt: now };
      records.set(id, record);
      values.set(id, input.value);
      return record;
    },
    async update(_projectId: string, id: string, patch: ProjectKeyPatch) {
      const record = records.get(id);
      if (!record) return null;
      if (patch.value !== undefined) values.set(id, patch.value);
      const updated = { ...record, ...(patch.name ? { name: patch.name } : {}), ...(patch.tags ? { tags: patch.tags } : {}) };
      records.set(id, updated);
      return updated;
    },
    async remove(_projectId: string, id: string) {
      return records.delete(id);
    },
    async reveal(_projectId: string, id: string) {
      return values.get(id) ?? null;
    },
  };
  return service as unknown as ProjectKeyService;
}

function app(keys: ProjectKeyService | null = fakeKeys()) {
  const server = Fastify();
  registerKeyRoutes(server, {
    projectFor: async (request) => (request.params.hash === HASH ? PROJECT : null),
    keys,
  });
  return server;
}

describe("key routes", () => {
  it("stores a key, lists it without its value, and reveals the value on request", async () => {
    const server = app();
    const created = await server.inject({
      method: "POST",
      url: `/api/projects/${HASH}/keys`,
      payload: { name: "OPENAI_API_KEY", value: "sk-secret", tags: ["openai", " openai ", "prod"], url: "https://platform.openai.com" },
    });
    expect(created.statusCode).toBe(201);
    const { key } = created.json();
    expect(key.tags).toEqual(["openai", "prod"]);
    expect(JSON.stringify(key)).not.toContain("sk-secret");

    const listed = await server.inject({ url: `/api/projects/${HASH}/keys` });
    expect(listed.body).not.toContain("sk-secret");
    expect(listed.json().keys).toHaveLength(1);

    const revealed = await server.inject({ url: `/api/projects/${HASH}/keys/${key.id}/value` });
    expect(revealed.json()).toEqual({ value: "sk-secret" });
    expect(revealed.headers["cache-control"]).toBe("no-store");
  });

  it("keeps a value exactly as pasted, whitespace included", async () => {
    const server = app();
    const { key } = (
      await server.inject({ method: "POST", url: `/api/projects/${HASH}/keys`, payload: { name: "PEM", value: "  line\n" } })
    ).json();
    const revealed = await server.inject({ url: `/api/projects/${HASH}/keys/${key.id}/value` });
    expect(revealed.json().value).toBe("  line\n");
  });

  it("refuses a missing name, an empty value, and a non-http URL", async () => {
    const server = app();
    const post = (payload: object) => server.inject({ method: "POST", url: `/api/projects/${HASH}/keys`, payload });
    expect((await post({ name: " ", value: "x" })).statusCode).toBe(400);
    expect((await post({ name: "A", value: "" })).statusCode).toBe(400);
    expect((await post({ name: "A", value: "x", url: "javascript:alert(1)" })).statusCode).toBe(400);
  });

  it("404s another person's project and an unknown key", async () => {
    const server = app();
    expect((await server.inject({ url: "/api/projects/zzzzzzzzzzzz/keys" })).statusCode).toBe(404);
    expect((await server.inject({ url: `/api/projects/${HASH}/keys/not-a-uuid/value` })).statusCode).toBe(404);
    const unknown = "00000000-0000-4000-8000-999999999999";
    expect((await server.inject({ url: `/api/projects/${HASH}/keys/${unknown}/value` })).statusCode).toBe(404);
    expect((await server.inject({ method: "DELETE", url: `/api/projects/${HASH}/keys/${unknown}` })).statusCode).toBe(404);
  });

  it("refuses to store anything without a SECRET_KEY", async () => {
    const server = app(null);
    const response = await server.inject({ method: "POST", url: `/api/projects/${HASH}/keys`, payload: { name: "A", value: "x" } });
    expect(response.statusCode).toBe(409);
  });
});
