import { Writable } from "node:stream";
import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  FIRST_PASSWORD_GRACE_MS,
  registerAccountKeyRoutes,
  type AccountKeyRouteDeps,
  type KeyAuditEntry,
} from "./account-keys-routes.js";
import {
  ACCOUNT_KEY_PROVIDERS,
  keyLast4,
  keyPrefix,
  unconfigured,
  type AccountKeyMeta,
  type AccountKeyProvider,
  type AccountKeyStore,
  type KeyCheck,
} from "./account-keys.js";
import { LOG_REDACT } from "./log-redact.js";
import { MemoryStepUpStore, STEP_UP_TTL_MS } from "./step-up.js";

const KEY = "sk-or-v1-0123456789abcdefSECRETVALUEbf58";
const OTHER_KEY = "sk-or-v1-zzzzzzzzzzzzzzzzzzzzOTHERKEY9999";
const PASSWORD = "correct horse battery staple";

/** Values held apart from metadata, as the real store holds ciphertext apart. */
function memoryStore(): AccountKeyStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  const metas = new Map<string, AccountKeyMeta>();
  const id = (u: string, p: string) => `${u}:${p}`;
  return {
    values,
    async list(userId) {
      return ACCOUNT_KEY_PROVIDERS.map((p) => metas.get(id(userId, p)) ?? unconfigured(p));
    },
    async save(userId, provider, key, scopes) {
      const replaced = values.has(id(userId, provider));
      values.set(id(userId, provider), key);
      const now = new Date().toISOString();
      const meta: AccountKeyMeta = {
        provider,
        configured: true,
        prefix: keyPrefix(provider, key),
        last4: keyLast4(key),
        scopes,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        lastRevealedAt: null,
      };
      metas.set(id(userId, provider), meta);
      return { meta, replaced };
    },
    async remove(userId, provider) {
      metas.delete(id(userId, provider));
      return values.delete(id(userId, provider));
    },
    async reveal(userId, provider) {
      const value = values.get(id(userId, provider)) ?? null;
      const meta = metas.get(id(userId, provider));
      if (value && meta) meta.lastRevealedAt = new Date().toISOString();
      return value;
    },
  };
}

function setup(options: {
  check?: (provider: AccountKeyProvider, key: string) => Promise<KeyCheck>;
  passwordAddedAt?: Date | null;
  hasPassword?: boolean;
  logs?: string[];
} = {}) {
  let clock = Date.parse("2026-11-07T12:00:00Z");
  const store = memoryStore();
  const stepUp = new MemoryStepUpStore();
  const audits: KeyAuditEntry[] = [];
  const logs = options.logs;
  const server = Fastify(
    logs
      ? {
          // The worst case: request logging on, at trace, with the real redaction.
          logger: {
            level: "trace",
            redact: LOG_REDACT,
            stream: new Writable({
              write(chunk, _enc, done) {
                logs.push(String(chunk));
                done();
              },
            }),
          },
        }
      : {},
  );
  const deps: AccountKeyRouteDeps = {
    // The user is named by a header here; in the server, by the session cookie.
    principal: async (request: FastifyRequest) => {
      const user = request.headers["x-user"];
      return typeof user === "string" ? { userId: user, sessionId: `session-${user}` } : null;
    },
    keys: store,
    encryptionAvailable: true,
    check: options.check ?? (async () => ({ ok: true, scopes: null })),
    password: {
      check: async (_userId, password) =>
        options.hasPassword === false ? "none" : password === PASSWORD ? "ok" : "wrong",
      state: async () => ({ hasPassword: options.hasPassword ?? true, addedAt: options.passwordAddedAt ?? null }),
    },
    stepUp,
    audit: async (entry) => {
      audits.push(entry);
      server.log.info({ audit: entry }, "audit");
    },
    now: () => clock,
  };
  registerAccountKeyRoutes(server, deps);

  const as = (user: string) => ({ "x-user": user, "user-agent": "vitest-agent" });
  const api = {
    save: (user: string, provider: string, key: string) =>
      server.inject({ method: "PUT", url: `/api/account/keys/${provider}`, headers: as(user), payload: { key } }),
    reauth: (user: string, password: string) =>
      server.inject({ method: "POST", url: "/api/account/reauth", headers: as(user), payload: { password } }),
    reveal: (user: string, provider: string, purpose?: "reveal" | "copy") =>
      server.inject({
        method: "POST",
        url: `/api/account/keys/${provider}/reveal`,
        headers: as(user),
        payload: purpose ? { purpose } : {},
      }),
    list: (user: string) => server.inject({ method: "GET", url: "/api/account/keys", headers: as(user) }),
    remove: (user: string, provider: string) =>
      server.inject({ method: "DELETE", url: `/api/account/keys/${provider}`, headers: as(user) }),
  };
  return { server, store, audits, api, advance: (ms: number) => (clock += ms) };
}

describe("listing keys", () => {
  it("returns metadata and never the key", async () => {
    const { api } = setup();
    expect((await api.save("alice", "openrouter", KEY)).statusCode).toBe(200);
    const listed = await api.list("alice");
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(KEY);
    expect(listed.body).not.toContain("SECRETVALUE");
    const openrouter = listed.json().keys.find((k: AccountKeyMeta) => k.provider === "openrouter");
    expect(openrouter).toMatchObject({ configured: true, prefix: "sk-or-v1-", last4: "bf58" });
    expect(listed.json().keys.find((k: AccountKeyMeta) => k.provider === "resend").configured).toBe(false);
  });

  it("does not echo the key when saving it", async () => {
    const { api } = setup();
    const saved = await api.save("alice", "openrouter", KEY);
    expect(saved.body).not.toContain(KEY);
  });
});

describe("reveal", () => {
  it("is refused without a step-up", async () => {
    const { api } = setup();
    await api.save("alice", "openrouter", KEY);
    const res = await api.reveal("alice", "openrouter");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
    expect(res.body).not.toContain(KEY);
    expect(res.headers["cache-control"]).toBe("no-store, max-age=0");
  });

  it("returns the key after a step-up, uncached", async () => {
    const { api } = setup();
    await api.save("alice", "openrouter", KEY);
    expect((await api.reauth("alice", PASSWORD)).json()).toEqual({ expiresInSeconds: 300 });
    const res = await api.reveal("alice", "openrouter");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ key: KEY, expiresInSeconds: 30 });
    expect(res.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(res.headers.pragma).toBe("no-cache");
    const listed = (await api.list("alice")).json().keys.find((k: AccountKeyMeta) => k.provider === "openrouter");
    expect(listed.lastRevealedAt).not.toBeNull();
  });

  it("is refused once the step-up is older than five minutes", async () => {
    const { api, advance } = setup();
    await api.save("alice", "openrouter", KEY);
    await api.reauth("alice", PASSWORD);
    advance(STEP_UP_TTL_MS - 1_000);
    expect((await api.reveal("alice", "openrouter")).statusCode).toBe(200);
    advance(2_000);
    const res = await api.reveal("alice", "openrouter");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("REAUTH_REQUIRED");
  });

  it("never reaches another user's key", async () => {
    const { api } = setup();
    await api.save("alice", "openrouter", KEY);
    await api.reauth("mallory", PASSWORD);
    const res = await api.reveal("mallory", "openrouter");
    expect([403, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain(KEY);
    // Alice's step-up does not carry to Mallory's session, nor the reverse.
    await api.save("mallory", "openrouter", OTHER_KEY);
    expect((await api.reveal("mallory", "openrouter")).json().key).toBe(OTHER_KEY);
    expect((await api.reveal("alice", "openrouter")).statusCode).toBe(403);
  });

  it("is rate-limited to ten per ten minutes", async () => {
    const { api, advance } = setup();
    await api.save("alice", "openrouter", KEY);
    for (let i = 0; i < 10; i++) {
      await api.reauth("alice", PASSWORD);
      expect((await api.reveal("alice", "openrouter")).statusCode).toBe(200);
      advance(1_000);
    }
    const res = await api.reveal("alice", "openrouter");
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("needs a password on the account", async () => {
    const { api } = setup({ hasPassword: false });
    await api.save("alice", "openrouter", KEY);
    expect((await api.reauth("alice", "anything")).statusCode).toBe(409);
    const res = await api.reveal("alice", "openrouter");
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("PASSWORD_REQUIRED");
  });

  it("will not take a first password for an hour after it was added", async () => {
    const added = new Date(Date.parse("2026-11-07T12:00:00Z") - 10 * 60_000);
    const { api, advance } = setup({ passwordAddedAt: added });
    await api.save("alice", "openrouter", KEY);
    await api.reauth("alice", PASSWORD);
    const res = await api.reveal("alice", "openrouter");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PASSWORD_TOO_NEW" });
    advance(FIRST_PASSWORD_GRACE_MS);
    await api.reauth("alice", PASSWORD);
    expect((await api.reveal("alice", "openrouter")).statusCode).toBe(200);
  });
});

describe("reauth", () => {
  it("answers a wrong password with 401, and the sixth attempt in ten minutes with 429", async () => {
    const { api, advance } = setup();
    for (let i = 0; i < 5; i++) {
      const res = await api.reauth("alice", `wrong-${i}`);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("That password isn't right.");
      advance(10_000);
    }
    const sixth = await api.reauth("alice", PASSWORD);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toMatch(/Too many attempts, try again in \d+ minutes?\.|Too many attempts. Try again in \d+ minutes?\./);
    expect(Number(sixth.headers["retry-after"])).toBeGreaterThan(0);
    // Another user is not caught by Alice's limit.
    expect((await api.reauth("bob", PASSWORD)).statusCode).toBe(200);
    advance(10 * 60_000);
    expect((await api.reauth("alice", PASSWORD)).statusCode).toBe(200);
  });
});

describe("activity", () => {
  it("writes exactly one entry per reveal and per copy, with no key in it", async () => {
    const { api, audits } = setup();
    await api.save("alice", "openrouter", KEY);
    await api.reauth("alice", PASSWORD);
    const before = audits.length;
    await api.reveal("alice", "openrouter");
    expect(audits.length).toBe(before + 1);
    expect(audits.at(-1)).toMatchObject({
      action: "api_key.revealed",
      provider: "openrouter",
      userId: "alice",
      details: { provider: "openrouter", userAgent: "vitest-agent", ip: expect.any(String), at: expect.any(String) },
    });
    await api.reveal("alice", "openrouter", "copy");
    expect(audits.length).toBe(before + 2);
    expect(audits.at(-1)!.action).toBe("api_key.copied");
    // A refused reveal is not an access.
    await api.reveal("alice", "resend");
    expect(audits.length).toBe(before + 2);
    expect(JSON.stringify(audits)).not.toContain(KEY);
    expect(JSON.stringify(audits)).not.toContain("SECRETVALUE");
  });

  it("logs created, replaced and removed", async () => {
    const { api, audits } = setup();
    await api.save("alice", "openrouter", KEY);
    await api.save("alice", "openrouter", OTHER_KEY);
    await api.remove("alice", "openrouter");
    expect(audits.map((a) => a.action)).toEqual(["api_key.created", "api_key.replaced", "api_key.removed"]);
    expect(JSON.stringify(audits)).not.toContain(KEY);
    expect(JSON.stringify(audits)).not.toContain(OTHER_KEY);
  });
});

describe("saving", () => {
  it("refuses a malformed key without asking the provider", async () => {
    let asked = 0;
    const { api, store } = setup({ check: async () => (asked++, { ok: true, scopes: null }) });
    const res = await api.save("alice", "github", "not-a-token");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/ghp_/);
    expect(asked).toBe(0);
    expect(store.values.size).toBe(0);
  });

  it("returns the provider's verdict and keeps the stored key when the live check fails", async () => {
    const rejected = "OpenRouter rejected this key (HTTP 401). Check it was copied in full and hasn't been revoked.";
    let reject = false;
    const { api, store, audits } = setup({
      check: async () => (reject ? { ok: false, error: rejected } : { ok: true, scopes: null }),
    });
    await api.save("alice", "openrouter", KEY);
    reject = true;
    const res = await api.save("alice", "openrouter", OTHER_KEY);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe(rejected);
    expect(res.body).not.toContain(OTHER_KEY);
    expect(store.values.get("alice:openrouter")).toBe(KEY);
    expect(audits.map((a) => a.action)).toEqual(["api_key.created"]);
  });

  it("stores GitHub scopes from the check", async () => {
    const { api } = setup({ check: async () => ({ ok: true, scopes: "repo, read:org" }) });
    const token = `ghp_${"A".repeat(36)}`;
    const res = await api.save("alice", "github", token);
    expect(res.json().key).toMatchObject({ prefix: "ghp_", scopes: "repo, read:org", last4: "AAAA" });
  });

  it("keeps the older settings route working for scripts, without a live check", async () => {
    let asked = 0;
    const { server, store, audits } = setup({ check: async () => (asked++, { ok: true, scopes: null }) });
    const res = await server.inject({
      method: "PUT",
      url: "/api/settings/openrouter",
      headers: { "x-user": "alice" },
      payload: { apiKey: "sk-or-v1-mock" },
    });
    expect(res.json()).toEqual({ openrouter: { configured: true, hint: "mock" } });
    expect(asked).toBe(0);
    expect(store.values.get("alice:openrouter")).toBe("sk-or-v1-mock");
    expect(audits.map((a) => a.action)).toEqual(["api_key.created"]);
  });
});

describe("logs", () => {
  it("never contain the key or the password through a whole save, reveal and copy flow", async () => {
    const logs: string[] = [];
    const { server, api } = setup({ logs });
    // Something careless, to prove the redaction rather than the absence of logging.
    server.addHook("preHandler", async (request) => {
      request.log.info({ body: request.body, headers: request.headers }, "incoming");
    });
    await api.save("alice", "openrouter", KEY);
    await api.reauth("alice", "wrong password");
    await api.reauth("alice", PASSWORD);
    await api.reveal("alice", "openrouter");
    await api.reveal("alice", "openrouter", "copy");
    await server.inject({
      method: "PUT",
      url: "/api/settings/openrouter",
      headers: { "x-user": "alice", authorization: `Bearer ${OTHER_KEY}` },
      payload: { apiKey: OTHER_KEY },
    });
    await server.close();
    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(5);
    expect(all).toContain("[redacted]");
    for (const secret of [KEY, OTHER_KEY, PASSWORD, "SECRETVALUE"]) expect(all).not.toContain(secret);
  });
});
