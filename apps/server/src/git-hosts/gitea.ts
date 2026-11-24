import { call, cloneUrlOf, GitHostError, MAX_LISTED, rec, splitName, str, type GitHost, type GitRepo, type HostContext } from "./types.js";

/** Gitea's default maximum; a server may cap lower, so a short page is not the last one. */
const LIMIT = 50;
const MAX_PAGES = 30;

const api = (ctx: HostContext, path: string, post?: unknown) =>
  call("Gitea", ctx, `token ${ctx.token}`, `/api/v1${path}`, post);

async function paged(ctx: HostContext, path: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES && all.length < MAX_LISTED; page++) {
    const { body, headers } = await api(ctx, `${path}?limit=${LIMIT}&page=${page}`);
    if (!Array.isArray(body)) throw new GitHostError("That address did not answer like Gitea. Check the server URL.", 502);
    all.push(...body);
    const total = Number(headers.get("x-total-count") ?? Number.NaN);
    if (body.length === 0 || all.length >= total) break;
  }
  return all;
}

function toRepo(ctx: HostContext, value: unknown): GitRepo | null {
  const r = rec(value);
  const fullName = str(r.full_name);
  const parts = fullName && splitName(fullName);
  if (!fullName || !parts) return null;
  return {
    fullName,
    ...parts,
    private: r.private === true || r.internal === true,
    defaultBranch: str(r.default_branch) ?? "main",
    cloneUrl: cloneUrlOf(ctx.baseUrl, fullName),
    description: str(r.description),
    pushedAt: str(r.updated_at),
  };
}

const repoPath = (fullName: string) => {
  const parts = splitName(fullName);
  if (!parts || parts.owner.includes("/")) throw new GitHostError("not a repository name", 400);
  return `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.name)}`;
};

async function username(ctx: HostContext): Promise<string> {
  const login = str(rec((await api(ctx, "/user")).body).login);
  if (!login) throw new GitHostError("That address did not answer like Gitea. Check the server URL.", 502);
  return login;
}

export const gitea: GitHost = {
  async identify(ctx) {
    return { login: await username(ctx), scopes: null };
  },
  async listRepos(ctx) {
    const repos = (await paged(ctx, "/user/repos")).flatMap((entry) => toRepo(ctx, entry) ?? []);
    return repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""));
  },
  async listBranches(ctx, fullName) {
    const path = repoPath(fullName);
    const [repo, list] = await Promise.all([api(ctx, path), paged(ctx, `${path}/branches`)]);
    const branches = list.flatMap((entry) => str(rec(entry).name) ?? []);
    const defaultBranch = str(rec(repo.body).default_branch);
    if (defaultBranch && !branches.includes(defaultBranch)) branches.unshift(defaultBranch);
    return { branches, defaultBranch: defaultBranch ?? branches[0] ?? null };
  },
  async listOwners(ctx) {
    const [me, orgs] = await Promise.all([username(ctx), paged(ctx, "/user/orgs")]);
    return [
      { login: me, kind: "user" as const },
      ...orgs.flatMap((o) => {
        const login = str(rec(o).username) ?? str(rec(o).name);
        return login ? [{ login, kind: "org" as const }] : [];
      }),
    ];
  },
  async createRepo(ctx, input) {
    const me = await username(ctx);
    const path =
      input.owner.toLowerCase() === me.toLowerCase() ? "/user/repos" : `/orgs/${encodeURIComponent(input.owner)}/repos`;
    const { body } = await api(ctx, path, {
      name: input.name,
      private: input.private,
      auto_init: input.autoInit,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    });
    const repo = toRepo(ctx, body);
    if (!repo) throw new GitHostError("Gitea answered no repository.", 502);
    return repo;
  },
};
