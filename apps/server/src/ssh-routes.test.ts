import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SshHostRow } from "@ucch/db";
import type { WorkspacePermission } from "@ucch/protocol";
import { registerSshRoutes, REMOTE_UNWATCHED_MS } from "./ssh-routes.js";
import { summarizeSshHost, type SshHostService, type SshPool } from "./ssh-hosts.js";
import type { RemoteChatReactor } from "./remote-chat.js";
import { encryptSecret } from "./crypto.js";

const SECRET = "ab".repeat(32);
const WS = "11111111-1111-4111-8111-111111111111";
const HOST = "22222222-2222-4222-8222-222222222222";

const ROLES: Record<string, WorkspacePermission[]> = {
  viewer: ["workspace.view"],
  writer: ["workspace.view", "project.write"],
  manager: ["workspace.view", "project.write", "workspace.manage"],
  outsider: [],
};

let role: keyof typeof ROLES | null;
let app: ReturnType<typeof Fastify>;
let row: SshHostRow;
const openRemote = vi.fn(() => true);

beforeEach(async () => {
  role = "manager";
  openRemote.mockClear();
  row = {
    id: HOST,
    workspaceId: WS,
    name: "web",
    host: "203.0.113.10",
    port: 22,
    username: "deploy",
    authMethod: "password",
    secretEncrypted: encryptSecret("hunter2", SECRET),
    passphraseEncrypted: null,
    hostKeySha256: "SHA256:abc",
    createdBy: null,
    createdAt: new Date(0),
  } as SshHostRow;
  const hosts = {
    list: async () => [summarizeSshHost(row)],
    get: async (id: string) => (id === HOST ? row : null),
    create: async (_ws: string, input: { name: string }) => summarizeSshHost({ ...row, name: input.name }),
    update: async () => summarizeSshHost(row),
    setHostKey: async () => {},
    remove: async () => {},
  } as unknown as SshHostService;
  app = Fastify();
  registerSshRoutes(app, {
    principalFor: async () => (role ? { userId: role } : null),
    workspaceAllows: async (ws, userId, permission) => ws === WS && (ROLES[userId] ?? []).includes(permission),
    hosts,
    pool: { drop: () => {}, get: async () => { throw new Error("no network in tests"); } } as unknown as SshPool,
    terminals: { openRemote, mayWatch: () => true, has: () => false, close: () => {} },
    chats: { dropHost: () => {} } as unknown as RemoteChatReactor,
    secretKey: SECRET,
    maxUploadBytes: 1024,
    probe: async () => "SHA256:abc",
    shell: (() => ({})) as never,
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const create = { name: "db", host: "203.0.113.11", username: "root", authMethod: "password", secret: "pw" };

describe("ssh routes", () => {
  it("never sends a stored secret back", async () => {
    const response = await app.inject(`/api/workspaces/${WS}/ssh-hosts`);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("secretEncrypted");
    expect(response.json().hosts?.[0] ?? response.json()[0]).toMatchObject({ name: "web", hostKeySha256: "SHA256:abc" });
  });

  it("lets viewers list, writers connect, and only managers add or remove", async () => {
    const terminal = { method: "POST" as const, url: `/api/ssh-hosts/${HOST}/terminals`, payload: { terminalId: crypto.randomUUID(), cols: 80, rows: 24 } };
    const add = { method: "POST" as const, url: `/api/workspaces/${WS}/ssh-hosts`, payload: create };
    const remove = { method: "DELETE" as const, url: `/api/ssh-hosts/${HOST}` };

    role = "viewer";
    expect((await app.inject(`/api/workspaces/${WS}/ssh-hosts`)).statusCode).toBe(200);
    expect((await app.inject(terminal)).statusCode).toBe(403);
    expect((await app.inject(add)).statusCode).toBe(403);

    role = "writer";
    expect((await app.inject(terminal)).statusCode).toBeLessThan(300);
    expect(openRemote).toHaveBeenCalledOnce();
    expect((await app.inject(add)).statusCode).toBe(403);
    expect((await app.inject(remove)).statusCode).toBe(403);

    role = "manager";
    expect((await app.inject(add)).statusCode).toBeLessThan(300);
    expect((await app.inject(remove)).statusCode).toBeLessThan(300);
  });

  it("hides a host from someone outside its workspace, and asks the signed-out to sign in", async () => {
    role = "outsider";
    expect((await app.inject(`/api/ssh-hosts/${HOST}`)).statusCode).toBe(404);
    expect((await app.inject(`/api/workspaces/${WS}/ssh-hosts`)).statusCode).toBe(404);
    role = null;
    expect((await app.inject(`/api/ssh-hosts/${HOST}`)).statusCode).toBe(401);
  });
});

describe("remote shells nobody watches", () => {
  it("are closed after the grace, and kept while a socket watches", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      let watching = true;
      const close = vi.fn();
      const local = Fastify();
      registerSshRoutes(local, {
        principalFor: async () => ({ userId: "writer" }),
        workspaceAllows: async (_ws, userId, permission) => (ROLES[userId] ?? []).includes(permission),
        hosts: { get: async () => row, setHostKey: async () => {} } as unknown as SshHostService,
        pool: {} as SshPool,
        terminals: { openRemote: () => true, mayWatch: () => true, has: () => close.mock.calls.length === 0, close },
        watched: () => watching,
        chats: {} as RemoteChatReactor,
        secretKey: SECRET,
        maxUploadBytes: 1024,
        shell: (() => ({})) as never,
      });
      const opened = await local.inject({
        method: "POST",
        url: `/api/ssh-hosts/${HOST}/terminals`,
        payload: { terminalId: crypto.randomUUID(), cols: 80, rows: 24 },
      });
      expect(opened.statusCode).toBe(201);
      await vi.advanceTimersByTimeAsync(REMOTE_UNWATCHED_MS * 3);
      expect(close).not.toHaveBeenCalled();
      watching = false;
      await vi.advanceTimersByTimeAsync(REMOTE_UNWATCHED_MS - 15_000);
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(close).toHaveBeenCalledOnce();
      await local.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
