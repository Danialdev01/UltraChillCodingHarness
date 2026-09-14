/**
 * The GitHub half of creating a project.
 *
 * Three calls, and no more: list the repositories an account can see, list one
 * repository's branches, and put credentials on a clone URL. Listing is the
 * part git cannot do -- `ls-remote` reads a repository you can already name,
 * and the dialog's whole purpose is to not have to name it -- so it is the
 * part that needs an API and a token.
 *
 * Nothing here touches the database or the event log. The token arrives as an
 * argument, decrypted by the caller for exactly the one call, and the clone
 * URL this builds is handed to git and never written anywhere.
 */

const BASE = "https://api.github.com";

/** Per page, which is also GitHub's maximum. */
const PER_PAGE = 100;

/**
 * How many pages of repositories to read.
 *
 * Three hundred, newest activity first, is the list a person recognises their
 * work in; an account with more than that has a long tail it would scroll
 * past anyway. The cap is what keeps opening a dialog from costing thirty
 * sequential API calls.
 */
const MAX_PAGES = 3;

/** A repository, as the new-project dialog needs it. */
export interface GithubRepo {
  /** `owner/name`, which is the identity everywhere else in this flow. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  /** The HTTPS URL, which is the one a clone with a token can use. */
  cloneUrl: string;
  description: string | null;
  /** ISO 8601, and the order the list arrives in. */
  pushedAt: string | null;
}

/** The account a token belongs to, for the settings page's benefit. */
export interface GithubIdentity {
  login: string;
  name: string | null;
}

/**
 * What the caller is allowed to do with a GitHub failure.
 *
 * A status as well as a message, because the routes care about the difference:
 * a rejected token is something the person fixes in settings, a missing
 * repository is something they fix in the dialog, and a rate limit is
 * something they fix by waiting.
 */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/** The `fetch` this module uses, so a test can hand it answers. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * One authenticated GET, with GitHub's failures turned into ours.
 *
 * The token goes in a header and nowhere else -- never in the URL, which would
 * put it in every log line that records the request.
 */
async function get(
  path: string,
  token: string,
  options: GithubOptions | undefined,
): Promise<unknown> {
  const call = options?.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${BASE}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "ucch",
      },
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new GithubError(
      `could not reach GitHub: ${error instanceof Error ? error.message : String(error)}`,
      502,
    );
  }

  if (response.ok) return response.json();

  if (response.status === 401) {
    throw new GithubError("GitHub rejected that token. Check it in Settings → API.", 401);
  }
  if (response.status === 404) {
    throw new GithubError("GitHub has no such repository, or the token cannot see it.", 404);
  }
  // A 403 with the remaining count at zero is the rate limit; a 403 without
  // it is a scope the token does not have, and the two need different fixes.
  if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
    throw new GithubError("GitHub's rate limit is exhausted. Try again shortly.", 429);
  }
  if (response.status === 403) {
    throw new GithubError(
      "That token is not allowed to do this. It needs the `repo` scope to see private repositories.",
      403,
    );
  }
  throw new GithubError(`GitHub answered ${response.status}.`, 502);
}

/**
 * The repositories this token can see, newest activity first.
 *
 * `affiliation` is explicit rather than left to default so a repository the
 * person contributes to but does not own is offered too -- the default is
 * owner plus collaborator plus organisation member, and saying so is what
 * keeps it from silently changing underneath.
 *
 * Paging stops at the first short page: GitHub has no total to read, and a
 * page with fewer than `PER_PAGE` entries is the last one.
 */
export async function listRepos(token: string, options?: GithubOptions): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await get(
      `/user/repos?per_page=${PER_PAGE}&page=${page}&sort=pushed&direction=desc` +
        "&affiliation=owner,collaborator,organization_member",
      token,
      options,
    );
    if (!Array.isArray(body)) break;
    for (const entry of body) {
      const repo = toRepo(entry);
      if (repo) repos.push(repo);
    }
    if (body.length < PER_PAGE) break;
  }

  return repos;
}

/**
 * One repository's branches, and which one it defaults to.
 *
 * The repository itself is the second call, because the branch list does not
 * say which branch is default and the dialog has to preselect one. It goes in
 * parallel with the first page, so the common case -- a repository with fewer
 * than a hundred branches -- costs one round trip rather than two.
 *
 * Later pages are sequential and conditional: a repository with three
 * branches should not pay for three requests to discover that.
 */
export async function listBranches(
  token: string,
  owner: string,
  repo: string,
  options?: GithubOptions,
): Promise<{ branches: string[]; defaultBranch: string | null }> {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const page = (n: number) => get(`${path}/branches?per_page=${PER_PAGE}&page=${n}`, token, options);

  const branches: string[] = [];
  const take = (body: unknown): number => {
    if (!Array.isArray(body)) return 0;
    for (const entry of body) {
      const name = (entry as { name?: unknown })?.name;
      if (typeof name === "string" && name) branches.push(name);
    }
    return body.length;
  };

  const [details, first] = await Promise.all([get(path, token, options), page(1)]);
  let read = take(first);
  for (let n = 2; n <= MAX_PAGES && read === PER_PAGE; n++) read = take(await page(n));

  const fallback = (details as { default_branch?: unknown })?.default_branch;
  const defaultBranch = typeof fallback === "string" && fallback ? fallback : null;

  // A repository whose default is not among the branches read -- possible
  // only past the page cap -- would leave the dialog preselecting something
  // it cannot offer.
  if (defaultBranch && !branches.includes(defaultBranch)) branches.unshift(defaultBranch);

  return { branches, defaultBranch: defaultBranch ?? branches[0] ?? null };
}

/** Who a token belongs to. Used to confirm a saved token actually works. */
export async function identify(token: string, options?: GithubOptions): Promise<GithubIdentity> {
  const body = (await get("/user", token, options)) as { login?: unknown; name?: unknown };
  if (typeof body?.login !== "string") throw new GithubError("GitHub answered no account.", 502);
  return { login: body.login, name: typeof body.name === "string" ? body.name : null };
}

/** One entry of `/user/repos`, or null when it is not shaped like one. */
function toRepo(value: unknown): GithubRepo | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  const fullName = r.full_name;
  const cloneUrl = r.clone_url;
  if (typeof fullName !== "string" || typeof cloneUrl !== "string") return null;

  const [owner = "", name = ""] = fullName.split("/");
  if (!owner || !name) return null;

  return {
    fullName,
    owner,
    name,
    private: r.private === true,
    defaultBranch: typeof r.default_branch === "string" ? r.default_branch : "main",
    cloneUrl,
    description: typeof r.description === "string" ? r.description : null,
    pushedAt: typeof r.pushed_at === "string" ? r.pushed_at : null,
  };
}

/** Hosts whose HTTPS clone accepts a GitHub token as a password. */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(["github.com", "www.github.com"]);

/**
 * Whether the account's GitHub token is the right credential for this URL.
 *
 * The check is what keeps the token from being offered to a host it has no
 * business authenticating to: git asks its credential helper about whatever
 * host the URL names, so attaching the helper to a `gitlab.com` clone would
 * hand a GitHub token to GitLab. HTTPS only, because that is the transport a
 * token is a password for -- an `ssh:` URL wants a key, and `http:` would put
 * the credential on the wire in the clear.
 *
 * A URL that already carries credentials is left to them: somebody who wrote
 * a username into it meant that one.
 */
export function tokenAppliesTo(repoUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !GITHUB_HOSTS.has(url.hostname.toLowerCase())) return false;
  return !url.username && !url.password;
}

/**
 * A token taken back out of text that is about to be shown to someone.
 *
 * git quotes the URL it was given in its own error messages, so a failed
 * clone of a private repository would otherwise put the token in an event,
 * a log line, and the dialog. Called on the way out of every git failure
 * rather than at the one place it was first noticed.
 */
export function redactToken(text: string, token: string | null): string {
  if (!token) return text;
  return text.split(token).join("***");
}
