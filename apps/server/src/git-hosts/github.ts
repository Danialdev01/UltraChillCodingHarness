import { createRepo, listBranches, listOwners, listRepos, identify } from "../github.js";
import { cloneUrlOf, GitHostError, splitName, type GitHost, type GitRepo, type HostContext } from "./types.js";

/** GitHub, through the functions that already speak its API. */
const own = (ctx: HostContext, repo: GitRepo): GitRepo => ({ ...repo, cloneUrl: cloneUrlOf(ctx.baseUrl, repo.fullName) });

export const github: GitHost = {
  async identify(ctx) {
    // The scopes are a header on any reply; fine-grained tokens have none.
    let scopes: string | null = null;
    const fetch = async (url: string, init?: RequestInit) => {
      const response = await ctx.fetch(url, init);
      const header = response.headers.get("x-oauth-scopes");
      scopes = ctx.token.startsWith("github_pat_") || header === null ? "fine-grained" : header.trim() || "none";
      return response;
    };
    const { login } = await identify(ctx.token, { fetch });
    return { login, scopes };
  },
  async listRepos(ctx) {
    return (await listRepos(ctx.token, ctx)).map((repo) => own(ctx, repo));
  },
  listBranches(ctx, fullName) {
    const parts = splitName(fullName);
    if (!parts || parts.owner.includes("/")) throw new GitHostError("not a repository name", 400);
    return listBranches(ctx.token, parts.owner, parts.name, ctx);
  },
  listOwners: (ctx) => listOwners(ctx.token, ctx),
  createRepo: async (ctx, input) => own(ctx, await createRepo(ctx.token, input, ctx)),
};
