/**
 * What the new-project dialog needs from a git host, whichever it is.
 *
 * A repository's identity is its full path: `owner/name`, or a GitLab
 * `group/subgroup/name`, so it travels as one string throughout.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HostContext {
  /** `https://host[/path]`, without a trailing slash. */
  baseUrl: string;
  token: string;
  fetch: FetchLike;
}

export interface GitRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  description: string | null;
  /** ISO 8601; the order the list arrives in. */
  pushedAt: string | null;
}

export interface GitOwner {
  login: string;
  kind: "user" | "org";
}

export interface CreateRepo {
  owner: string;
  name: string;
  private: boolean;
  description?: string;
  autoInit: boolean;
}

export interface GitHost {
  identify(ctx: HostContext): Promise<{ login: string; scopes: string | null }>;
  listRepos(ctx: HostContext): Promise<GitRepo[]>;
  listBranches(ctx: HostContext, fullName: string): Promise<{ branches: string[]; defaultBranch: string | null }>;
  listOwners(ctx: HostContext): Promise<GitOwner[]>;
  createRepo(ctx: HostContext, input: CreateRepo): Promise<GitRepo>;
}

/** A host's failure, with the status the caller should see. */
export class GitHostError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHostError";
  }
}

/** How many repositories or branches are read before a list stops. */
export const MAX_LISTED = 300;

/** Built from the account's own address: a host's reply may name another. */
export function cloneUrlOf(baseUrl: string, fullName: string): string {
  return `${baseUrl}/${fullName.split("/").map(encodeURIComponent).join("/")}.git`;
}

export function splitName(fullName: string): { owner: string; name: string } | null {
  const at = fullName.lastIndexOf("/");
  if (at <= 0 || at === fullName.length - 1) return null;
  if (fullName.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return { owner: fullName.slice(0, at), name: fullName.slice(at + 1) };
}

export interface CallResult {
  body: unknown;
  headers: Headers;
}

/**
 * One call, with a host's failures turned into ours. No response body is ever
 * put in a message: the address is the person's to choose, and an error must
 * not read another server's pages back to them.
 */
export async function call(
  label: string,
  ctx: HostContext,
  authorization: string,
  path: string,
  post?: unknown,
): Promise<CallResult> {
  let response: Response;
  try {
    response = await ctx.fetch(`${ctx.baseUrl}${path}`, {
      method: post === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        authorization,
        "user-agent": "ucch",
        ...(post !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(post !== undefined ? { body: JSON.stringify(post) } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "it took too long to answer" : (error as Error).message;
    throw new GitHostError(`Could not reach ${label}: ${reason}`, 502);
  }
  if (response.ok) {
    try {
      return { body: await response.json(), headers: response.headers };
    } catch {
      throw new GitHostError(`That address did not answer like ${label}. Check the server URL.`, 502);
    }
  }
  void response.body?.cancel().catch(() => {});
  const { status } = response;
  if (status >= 300 && status < 400) {
    throw new GitHostError(`${label} answered with a redirect. Use the address it redirects to as the server URL.`, 502);
  }
  if (status === 401) throw new GitHostError(`${label} rejected that token. Check it in Settings → Providers.`, 401);
  if (status === 403) throw new GitHostError(`That token is not allowed to do this on ${label}. Check its scopes.`, 403);
  if (status === 404) throw new GitHostError(`${label} has no such thing, or the token cannot see it.`, 404);
  if (status === 429) throw new GitHostError(`${label}'s rate limit is exhausted. Try again shortly.`, 429);
  if (post !== undefined && (status === 400 || status === 409 || status === 422)) {
    throw new GitHostError(`${label} refused it. The name may be taken or not allowed there.`, 422);
  }
  throw new GitHostError(`${label} answered ${status}.`, 502);
}

export const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
export const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
