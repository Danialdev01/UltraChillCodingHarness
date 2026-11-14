import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, WORKSPACE_STORE_ID, type ResourceStoreSummary, type WorkspaceRole } from "@ucch/protocol";
import { registerResourceRoutes } from "./resource-routes.js";
import { LocalBackend, type ResourceStoreService } from "./resource-stores.js";

const WS = "00000000-0000-4000-8000-000000000001";
const roles: Record<string, WorkspaceRole> = { owner: "owner", member: "member", viewer: "viewer" };

let dir: string;

function build(secretKey: string | null = "k".repeat(64)) {
  const app = Fastify();
  void app.register(cookie);
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_r, body, done) => done(null, body));
  const created: unknown[] = [];
  const stores = {
    async list(): Promise<ResourceStoreSummary[]> {
      return [
        { id: WORKSPACE_STORE_ID, kind: "local", name: "Workspace storage" },
        {
          id: "s3-1",
          kind: "s3",
          name: "Team bucket",
          s3: { endpoint: null, region: "us-east-1", bucket: "b", prefix: "", forcePathStyle: false, accessKeyId: "AK" },
        },
      ];
    },
    async backend(_ws: string, storeId: string) {
      return storeId === WORKSPACE_STORE_ID ? new LocalBackend(dir) : null;
    },
    async create(_ws: string, _user: string, input: unknown) {
      created.push(input);
      return { id: "new", kind: "s3", name: "x" };
    },
    async update() {
      return null;
    },
    async remove() {
      return false;
    },
  } as unknown as ResourceStoreService;
  registerResourceRoutes(app, {
    principalFor: async (cookies) => (cookies.who ? { userId: cookies.who } : null),
    workspaceAllows: async (ws, userId, permission) => {
      const role = roles[userId];
      return ws === WS && role !== undefined && ROLE_PERMISSIONS[role].includes(permission);
    },
    stores,
    secretKey: secretKey ?? undefined,
    maxUploadBytes: 1024 * 1024,
  });
  return { app, created };
}

const as = (who: string) => ({ cookie: `who=${who}` });

describe("resource routes", () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ucch-resource-routes-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hides the workspace from strangers and the signed-out", async () => {
    const { app } = build();
    expect((await app.inject({ url: `/api/workspaces/${WS}/resource-stores` })).statusCode).toBe(401);
    const res = await app.inject({ url: `/api/workspaces/${WS}/resource-stores`, headers: as("stranger") });
    expect(res.statusCode).toBe(404);
  });

  it("lists stores without any secret", async () => {
    const { app } = build();
    const res = await app.inject({ url: `/api/workspaces/${WS}/resource-stores`, headers: as("viewer") });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/secret/i);
    expect(res.json().stores[0].id).toBe(WORKSPACE_STORE_ID);
  });

  it("lets a member upload and a viewer only read", async () => {
    const { app } = build();
    const upload = (who: string) =>
      app.inject({
        method: "POST",
        url: `/api/workspaces/${WS}/resources/${WORKSPACE_STORE_ID}?key=docs/a.txt`,
        headers: { ...as(who), "content-type": "application/octet-stream" },
        payload: Buffer.from("hello"),
      });
    expect((await upload("viewer")).statusCode).toBe(403);
    expect((await upload("member")).statusCode).toBe(201);
    expect((await upload("member")).statusCode).toBe(409);

    const list = await app.inject({
      url: `/api/workspaces/${WS}/resources/${WORKSPACE_STORE_ID}?prefix=docs`,
      headers: as("viewer"),
    });
    expect(list.json().entries.map((e: { key: string }) => e.key)).toEqual(["docs/a.txt"]);

    const download = await app.inject({
      url: `/api/workspaces/${WS}/resources/${WORKSPACE_STORE_ID}/content?key=docs/a.txt&download=1`,
      headers: as("viewer"),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(download.body).toBe("hello");

    const del = (who: string) =>
      app.inject({
        method: "DELETE",
        url: `/api/workspaces/${WS}/resources/${WORKSPACE_STORE_ID}?key=docs`,
        headers: as(who),
      });
    expect((await del("viewer")).statusCode).toBe(403);
    expect((await del("member")).statusCode).toBe(204);
  });

  it("refuses traversal keys", async () => {
    const { app } = build();
    const res = await app.inject({
      url: `/api/workspaces/${WS}/resources/${WORKSPACE_STORE_ID}?prefix=../x`,
      headers: as("member"),
    });
    expect(res.statusCode).toBe(400);
  });

  it("only lets credential managers add an S3 store, and only with SECRET_KEY", async () => {
    const body = { name: "Bucket", bucket: "team-bucket", accessKeyId: "AK", secretAccessKey: "SK" };
    const { app, created } = build();
    const post = (who: string) =>
      app.inject({ method: "POST", url: `/api/workspaces/${WS}/resource-stores`, headers: as(who), payload: body });
    expect((await post("member")).statusCode).toBe(403);
    expect((await post("owner")).statusCode).toBe(201);
    expect(created).toHaveLength(1);

    const noKey = build(null).app;
    const res = await noKey.inject({
      method: "POST",
      url: `/api/workspaces/${WS}/resource-stores`,
      headers: as("owner"),
      payload: body,
    });
    expect(res.statusCode).toBe(409);
  });

  it("is a 404 for a store the workspace does not have", async () => {
    const { app } = build();
    const res = await app.inject({ url: `/api/workspaces/${WS}/resources/nope`, headers: as("member") });
    expect(res.statusCode).toBe(404);
  });
});
