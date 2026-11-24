import { describe, expect, it } from "vitest";
import { GIT_HOSTS, type HostContext } from "./index.js";

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

function host(baseUrl: string, answer: (path: string, init: RequestInit) => Answer) {
  const calls: { path: string; init: RequestInit }[] = [];
  const ctx: HostContext = {
    baseUrl,
    token: "secret",
    fetch: async (url, init = {}) => {
      const path = url.slice(baseUrl.length);
      calls.push({ path, init });
      const { status = 200, body = {}, headers } = answer(path, init);
      return new Response(JSON.stringify(body), { status, headers });
    },
  };
  return { ctx, calls };
}
const auth = (init: RequestInit) => (init.headers as Record<string, string>).authorization;

describe("GitLab", () => {
  const base = "https://gl.example.com/sub";
  const project = { path_with_namespace: "group/team/engine", visibility: "internal", default_branch: "trunk", http_url_to_repo: "http://wrong/x.git" };

  it("lists nested projects, cloning from the account's own address", async () => {
    const { ctx, calls } = host(base, () => ({ body: [project] }));
    expect(await GIT_HOSTS.gitlab.listRepos(ctx)).toMatchObject([
      { fullName: "group/team/engine", owner: "group/team", name: "engine", private: true, defaultBranch: "trunk", cloneUrl: `${base}/group/team/engine.git` },
    ]);
    expect(auth(calls[0]!.init)).toBe("Bearer secret");
    expect(calls[0]!.path).not.toContain("secret");
  });

  it("stops at a short page and at the cap", async () => {
    const pages = host(base, (path) => ({ body: Array(path.endsWith("&page=1") ? 100 : 5).fill(project) }));
    expect(await GIT_HOSTS.gitlab.listRepos(pages.ctx)).toHaveLength(105);
    const endless = host(base, () => ({ body: Array(100).fill(project) }));
    expect(await GIT_HOSTS.gitlab.listRepos(endless.ctx)).toHaveLength(300);
    expect(endless.calls).toHaveLength(3);
  });

  it("names a project by its encoded path for branches", async () => {
    const { ctx, calls } = host(base, (path) => ({ body: path.includes("/branches") ? [{ name: "a" }] : project }));
    expect(await GIT_HOSTS.gitlab.listBranches(ctx, "group/team/engine")).toEqual({ branches: ["trunk", "a"], defaultBranch: "trunk" });
    expect(calls.every((c) => c.path.startsWith("/api/v4/projects/group%2Fteam%2Fengine"))).toBe(true);
    await expect(GIT_HOSTS.gitlab.listBranches(ctx, "../x")).rejects.toThrow();
  });

  it("creates under the person, or a group by its id", async () => {
    const sent: unknown[] = [];
    const { ctx } = host(base, (path, init) => {
      if (init.method === "POST") sent.push(JSON.parse(String(init.body)));
      return { body: path.endsWith("/user") ? { username: "ada" } : path.includes("/groups/") ? { id: 7 } : project };
    });
    const input = { name: "engine", private: true, autoInit: true };
    await GIT_HOSTS.gitlab.createRepo(ctx, { ...input, owner: "Ada" });
    await GIT_HOSTS.gitlab.createRepo(ctx, { ...input, owner: "group/team" });
    expect(sent).toEqual([
      { name: "engine", path: "engine", visibility: "private", initialize_with_readme: true },
      { name: "engine", path: "engine", visibility: "private", initialize_with_readme: true, namespace_id: 7 },
    ]);
  });

  it("works for a token whose scopes it will not tell", async () => {
    const { ctx } = host(base, (path) => (path.endsWith("/user") ? { body: { username: "ada" } } : { status: 404 }));
    expect(await GIT_HOSTS.gitlab.identify(ctx)).toEqual({ login: "ada", scopes: null });
  });
});

describe("Gitea", () => {
  const base = "http://localhost:3000";
  const repo = { full_name: "ada/engine", private: false, default_branch: "main", clone_url: "http://wrong/x.git", updated_at: "2026-01-01T00:00:00Z" };

  it("keeps paging past a server's lower cap, until the total", async () => {
    const { ctx, calls } = host(base, () => ({ body: Array(10).fill(repo), headers: { "x-total-count": "20" } }));
    expect(await GIT_HOSTS.gitea.listRepos(ctx)).toHaveLength(20);
    expect(calls).toHaveLength(2);
    expect(auth(calls[0]!.init)).toBe("token secret");
  });

  it("stops at an empty page when there is no total", async () => {
    const { ctx } = host(base, (path) => ({ body: path.endsWith("page=1") ? [repo] : [] }));
    expect(await GIT_HOSTS.gitea.listRepos(ctx)).toMatchObject([{ cloneUrl: `${base}/ada/engine.git`, private: false }]);
  });

  it("creates under the person or an organisation", async () => {
    const { ctx, calls } = host(base, (path) => ({ body: path.endsWith("/user") ? { login: "ada" } : repo }));
    const input = { name: "engine", private: true, autoInit: true };
    await GIT_HOSTS.gitea.createRepo(ctx, { ...input, owner: "ada" });
    await GIT_HOSTS.gitea.createRepo(ctx, { ...input, owner: "org" });
    expect(calls.filter((c) => c.init.method === "POST").map((c) => c.path)).toEqual(["/api/v1/user/repos", "/api/v1/orgs/org/repos"]);
  });
});

describe("failures", () => {
  it("carry a status and never the host's own words", async () => {
    for (const [status, expected] of [[401, 401], [403, 403], [404, 404], [429, 429], [302, 502], [500, 502]] as const) {
      const { ctx } = host("https://x.example", () => ({ status, body: { message: "internal secret page" } }));
      const error = await GIT_HOSTS.gitea.identify(ctx).catch((e) => e);
      expect(error.status).toBe(expected);
      expect(error.message).not.toContain("internal secret page");
    }
  });

  it("say so when the address is something else", async () => {
    const { ctx } = host("https://x.example", () => ({ body: { hello: 1 } }));
    await expect(GIT_HOSTS.gitea.identify(ctx)).rejects.toThrow(/did not answer like Gitea/);
    await expect(GIT_HOSTS.gitlab.listRepos(ctx)).rejects.toThrow(/did not answer like GitLab/);
  });
});

describe("GitHub", () => {
  it("reads classic scopes, and calls a token without the header fine-grained", async () => {
    const ctx = (token: string, headers?: Record<string, string>): HostContext => ({
      baseUrl: "https://github.com",
      token,
      fetch: async () => new Response(JSON.stringify({ login: "ada" }), { headers }),
    });
    expect(await GIT_HOSTS.github.identify(ctx("ghp_x", { "x-oauth-scopes": "repo" }))).toEqual({ login: "ada", scopes: "repo" });
    expect(await GIT_HOSTS.github.identify(ctx("github_pat_x"))).toEqual({ login: "ada", scopes: "fine-grained" });
  });
});
