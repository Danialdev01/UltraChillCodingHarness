import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { DuplicateAccountName, type GitAccountMeta, type GitAccountStore, type TokenCheck } from "./git-accounts.js";
import { MAX_GIT_ACCOUNTS, registerGitAccountRoutes, type GitAccountAuditEntry } from "./git-accounts-routes.js";

const TOKEN = "gitea-token-0123456789-abcd";

function setup(options: { check?: () => TokenCheck; fetch?: (url: string) => Response } = {}) {
  const rows: (GitAccountMeta & { userId: string; token: string })[] = [];
  const audits: GitAccountAuditEntry[] = [];
  const checks: string[] = [];
  const meta = ({ userId: _u, token: _t, ...m }: (typeof rows)[number]): GitAccountMeta => m;
  const find = (userId: string, id: string) => rows.find((r) => r.userId === userId && r.id === id);
  const store: GitAccountStore = {
    list: async (userId) => rows.filter((r) => r.userId === userId).map(meta),
    create: async (userId, { token, ...input }) => {
      if (rows.some((r) => r.userId === userId && r.name === input.name)) throw new DuplicateAccountName(input.name);
      const row = {
        ...input, userId, token, id: crypto.randomUUID(), prefix: "", last4: token.slice(-4),
        createdAt: new Date().toISOString(), lastUsedAt: null,
      };
      rows.push(row);
      return meta(row);
    },
    rename: async (userId, id, name) => {
      const row = find(userId, id);
      return row ? meta(Object.assign(row, { name })) : null;
    },
    replaceToken: async (userId, id, token, login, scopes) => {
      const row = find(userId, id);
      return row ? meta(Object.assign(row, { token, login, scopes })) : null;
    },
    remove: async (userId, id) => {
      const row = find(userId, id);
      if (row) rows.splice(rows.indexOf(row), 1);
      return Boolean(row);
    },
  };
  const server = Fastify();
  registerGitAccountRoutes(server, {
    principal: async (request) => {
      const user = request.headers["x-user"];
      return typeof user === "string" ? { userId: user } : null;
    },
    accounts: store,
    encryptionAvailable: true,
    check: async (_p, baseUrl) => {
      checks.push(baseUrl);
      return options.check?.() ?? { ok: true, login: "ada", scopes: null };
    },
    sources: async (userId) =>
      rows.filter((r) => r.userId === userId).map((r) => ({ id: r.id, provider: r.provider, name: r.name, baseUrl: r.baseUrl, login: r.login, token: () => r.token })),
    learnLogin: () => {},
    fetch: async (url) => options.fetch?.(url) ?? new Response("{}", { status: 404 }),
    audit: async (entry) => void audits.push(entry),
    changed: () => {},
    onError: () => {},
  });
  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: object, user: string | null = "alice") =>
    server.inject({ method, url, headers: user ? { "x-user": user } : {}, ...(payload ? { payload } : {}) });
  const add = (over: object = {}, user = "alice") =>
    call("POST", "/api/account/git-accounts", { provider: "gitea", name: "Home", baseUrl: "https://git.example.com/", token: TOKEN, ...over }, user);
  return { call, add, rows, audits, checks };
}

describe("git accounts", () => {
  it("stores an account, and never answers its token", async () => {
    const { call, add, audits } = setup();
    const made = await add();
    expect(made.json().account).toMatchObject({ provider: "gitea", baseUrl: "https://git.example.com", login: "ada", last4: "abcd" });
    const list = await call("GET", "/api/account/git-accounts");
    for (const text of [made.body, list.body, JSON.stringify(audits)]) expect(text).not.toContain(TOKEN);
    expect(audits.map((a) => a.action)).toEqual(["git_account.created"]);
  });

  it("keeps several of one provider, but not two with one name", async () => {
    const { add, rows } = setup();
    await add();
    expect((await add({ name: "Work" })).statusCode).toBe(200);
    expect((await add({ name: "work" })).statusCode).toBe(409);
    expect(rows).toHaveLength(2);
  });

  it("fixes GitHub's address, defaults GitLab's, and needs Gitea's", async () => {
    const { add, checks } = setup();
    await add({ provider: "github", name: "a", baseUrl: "https://evil.example", token: `ghp_${"A".repeat(36)}` });
    await add({ provider: "gitlab", name: "b", baseUrl: undefined });
    expect(checks).toEqual(["https://github.com", "https://gitlab.com"]);
    expect((await add({ name: "c", baseUrl: undefined })).statusCode).toBe(400);
  });

  it("refuses bad tokens, rejected tokens, and more than the cap", async () => {
    const bad = setup();
    expect((await bad.add({ token: "a\nb" })).statusCode).toBe(400);
    expect((await bad.add({ provider: "github", token: "nope" })).json().error).toMatch(/ghp_/);
    expect(bad.checks).toEqual([]);
    const rejected = setup({ check: () => ({ ok: false, error: "no" }) });
    expect((await rejected.add()).statusCode).toBe(422);
    expect(rejected.rows).toHaveLength(0);
    const full = setup();
    for (let i = 0; i < MAX_GIT_ACCOUNTS; i++) await full.add({ name: `n${i}` });
    expect((await full.add({ name: "more" })).statusCode).toBe(409);
  });

  it("replaces a token against the saved address, which cannot be changed", async () => {
    const { call, add, rows, checks } = setup();
    const { id } = (await add()).json().account;
    const res = await call("PATCH", `/api/account/git-accounts/${id}`, { token: "new-token", baseUrl: "https://evil.example" });
    expect(res.statusCode).toBe(200);
    expect(checks).toEqual(["https://git.example.com", "https://git.example.com"]);
    expect(rows[0]).toMatchObject({ token: "new-token", baseUrl: "https://git.example.com" });
  });

  it("belongs to one person", async () => {
    const { call, add, rows } = setup();
    const { id } = (await add()).json().account;
    for (const [method, url, body] of [
      ["PATCH", `/api/account/git-accounts/${id}`, { name: "x" }],
      ["PATCH", `/api/account/git-accounts/${id}`, { token: "x" }],
      ["DELETE", `/api/account/git-accounts/${id}`, undefined],
      ["GET", `/api/git/accounts/${id}/owners`, undefined],
      ["GET", `/api/git/accounts/${id}/branches?repo=a/b`, undefined],
      ["POST", `/api/git/accounts/${id}/repos`, { owner: "a", name: "b" }],
    ] as const) {
      expect((await call(method, url, body, "mallory")).statusCode, `${method} ${url}`).toBe(404);
      expect((await call(method, url, body, null)).statusCode).toBe(401);
    }
    expect(rows[0]).toMatchObject({ name: "Home", token: TOKEN });
  });

  it("keeps the older GitHub route as the account named GitHub", async () => {
    const { call, rows } = setup();
    const put = (apiKey: string | null) => call("PUT", "/api/settings/github", { apiKey });
    expect((await put("ghp_mock")).json()).toEqual({ github: { configured: true, hint: "mock" } });
    await put("ghp_next");
    expect(rows.map((r) => [r.provider, r.name, r.token])).toEqual([["github", "GitHub", "ghp_next"]]);
    expect((await put(null)).json()).toEqual({ github: { configured: false, hint: null } });
    expect(rows).toEqual([]);
  });
});

describe("repositories", () => {
  const repo = (updated_at: string, full_name: string) => ({ full_name, updated_at, default_branch: "main" });

  it("joins every account's, newest first, with one failing reported beside the rest", async () => {
    const { call, add } = setup({
      fetch: (url) => {
        if (url.startsWith("https://down.example")) return new Response("{}", { status: 401 });
        if (url.endsWith("/user")) return Response.json({ login: "ada" });
        const old = url.startsWith("https://git.example.com");
        return Response.json([old ? repo("2026-01-01T00:00:00Z", "ada/old") : repo("2026-02-01T00:00:00Z", "ada/new")], {
          headers: { "x-total-count": "1" },
        });
      },
    });
    await add();
    await add({ name: "Work", baseUrl: "https://work.example" });
    await add({ name: "Down", baseUrl: "https://down.example" });
    const body = (await call("GET", "/api/git/repos")).json();
    expect(body.repos.map((r: { fullName: string; accountName: string }) => [r.fullName, r.accountName])).toEqual([["ada/new", "Work"], ["ada/old", "Home"]]);
    expect(body.accounts.map((a: { name: string }) => a.name)).toEqual(["Home", "Work"]);
    expect(body.errors).toMatchObject([{ name: "Down", provider: "gitea" }]);
  });

  it("does not pass a host's 401 on as the harness's own", async () => {
    const { call, add } = setup({ fetch: () => new Response("{}", { status: 401 }) });
    const { id } = (await add()).json().account;
    expect((await call("GET", `/api/git/accounts/${id}/owners`)).statusCode).toBe(422);
  });
});
