import { call, cloneUrlOf, GitHostError, MAX_LISTED, rec, splitName, str, type GitHost, type GitRepo, type HostContext } from "./types.js";

const PER_PAGE = 100;

const api = (ctx: HostContext, path: string, post?: unknown) =>
  call("GitLab", ctx, `Bearer ${ctx.token}`, `/api/v4${path}`, post);

async function paged(ctx: HostContext, path: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; all.length < MAX_LISTED; page++) {
    const { body } = await api(ctx, `${path}${path.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(body)) throw new GitHostError("That address did not answer like GitLab. Check the server URL.", 502);
    all.push(...body);
    if (body.length < PER_PAGE) break;
  }
  return all;
}

function toRepo(ctx: HostContext, value: unknown): GitRepo | null {
  const r = rec(value);
  const fullName = str(r.path_with_namespace);
  const parts = fullName && splitName(fullName);
  if (!fullName || !parts) return null;
  return {
    fullName,
    ...parts,
    private: r.visibility !== "public",
    defaultBranch: str(r.default_branch) ?? "main",
    cloneUrl: cloneUrlOf(ctx.baseUrl, fullName),
    description: str(r.description),
    pushedAt: str(r.last_activity_at),
  };
}

async function username(ctx: HostContext): Promise<string> {
  const login = str(rec((await api(ctx, "/user")).body).username);
  if (!login) throw new GitHostError("That address did not answer like GitLab. Check the server URL.", 502);
  return login;
}

export const gitlab: GitHost = {
  async identify(ctx) {
    const login = await username(ctx);
    // Personal tokens only; another kind still works without its scopes shown.
    const self = await api(ctx, "/personal_access_tokens/self").catch(() => null);
    const scopes = rec(self?.body).scopes;
    return { login, scopes: Array.isArray(scopes) ? scopes.filter((s) => typeof s === "string").join(", ") || null : null };
  },
  async listRepos(ctx) {
    const all = await paged(ctx, "/projects?membership=true&archived=false&order_by=last_activity_at&sort=desc");
    return all.flatMap((entry) => toRepo(ctx, entry) ?? []);
  },
  async listBranches(ctx, fullName) {
    if (!splitName(fullName)) throw new GitHostError("not a repository name", 400);
    const path = `/projects/${encodeURIComponent(fullName)}`;
    const [project, list] = await Promise.all([api(ctx, path), paged(ctx, `${path}/repository/branches`)]);
    const branches = list.flatMap((entry) => str(rec(entry).name) ?? []);
    const defaultBranch = str(rec(project.body).default_branch);
    if (defaultBranch && !branches.includes(defaultBranch)) branches.unshift(defaultBranch);
    return { branches, defaultBranch: defaultBranch ?? branches[0] ?? null };
  },
  async listOwners(ctx) {
    const [me, groups] = await Promise.all([username(ctx), paged(ctx, "/groups?min_access_level=30&order_by=path")]);
    return [
      { login: me, kind: "user" as const },
      ...groups.flatMap((g) => {
        const login = str(rec(g).full_path);
        return login ? [{ login, kind: "org" as const }] : [];
      }),
    ];
  },
  async createRepo(ctx, input) {
    const me = await username(ctx);
    let namespace: number | null = null;
    if (input.owner.toLowerCase() !== me.toLowerCase()) {
      const id = rec((await api(ctx, `/groups/${encodeURIComponent(input.owner)}?with_projects=false`)).body).id;
      if (typeof id !== "number") throw new GitHostError("GitLab has no such group, or the token cannot see it.", 404);
      namespace = id;
    }
    const { body } = await api(ctx, "/projects", {
      name: input.name,
      path: input.name,
      visibility: input.private ? "private" : "public",
      initialize_with_readme: input.autoInit,
      ...(namespace !== null ? { namespace_id: namespace } : {}),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    });
    const repo = toRepo(ctx, body);
    if (!repo) throw new GitHostError("GitLab answered no repository.", 502);
    return repo;
  },
};
