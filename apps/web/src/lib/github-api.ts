/**
 * GitHub, as the new-project dialog sees it.
 *
 * The token never reaches the browser: these call the harness, which holds the
 * account's token and talks to GitHub itself. So there is nothing to configure
 * here and nothing secret to leak -- the only state is whether the server has
 * a token at all, which is what `NoGithubToken` exists to say.
 */

/** A repository the account can see. Mirrors the server's `GithubRepo`. */
export interface GithubRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  description: string | null;
  pushedAt: string | null;
}

/** Whose repositories these are. */
export interface GithubAccount {
  login: string;
  name: string | null;
}

/**
 * No token is configured -- a state, not a failure.
 *
 * Its own class because the dialog's answer to it is different in kind: every
 * other error is "that did not work, here is why", and this one is "there is
 * nothing wrong, go and connect an account".
 */
export class NoGithubToken extends Error {
  constructor() {
    super("No GitHub token is configured.");
    this.name = "NoGithubToken";
  }
}

/** The server's message, or a fallback, as one throwable thing. */
async function fail(response: Response, fallback: string): Promise<never> {
  // 412 is the server's way of saying the account has no token. Checked before
  // the body is read, so a reply with no JSON in it still lands as the right
  // kind of error.
  if (response.status === 412) throw new NoGithubToken();
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

/** The repositories this account can see, and which account that is. */
export async function fetchRepos(): Promise<{ account: GithubAccount; repos: GithubRepo[] }> {
  const response = await fetch("/api/github/repos", { credentials: "include" });
  if (!response.ok) await fail(response, "Could not read your repositories.");
  return (await response.json()) as { account: GithubAccount; repos: GithubRepo[] };
}

/**
 * One repository's branches, and the one it defaults to.
 *
 * Read through the API rather than `ls-remote` because this is the tab that
 * has a token: a private repository's branches are only readable with it.
 */
export async function fetchBranches(
  owner: string,
  repo: string,
): Promise<{ branches: string[]; defaultBranch: string | null }> {
  const response = await fetch(
    `/api/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`,
    { credentials: "include" },
  );
  if (!response.ok) await fail(response, `Could not read the branches of ${owner}/${repo}.`);
  return (await response.json()) as { branches: string[]; defaultBranch: string | null };
}

/**
 * Whether a string is usable as a new repository's name.
 *
 * The same rule GitHub applies to a repository it creates, checked here so the
 * dialog can say so while the person is typing rather than after a round trip:
 * letters, digits, dot, dash and underscore. A name is not a path, so a slash
 * is refused rather than quietly flattened, and the leading-dot cases are out
 * because `.` and `..` are not names.
 */
export function isValidRepoName(name: string): boolean {
  const value = name.trim();
  if (!value || value.length > 100) return false;
  if (value === "." || value === "..") return false;
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * A typed name turned into the one a repository would actually get.
 *
 * Spaces become dashes because that is what someone typing "my new app" means,
 * and it is the same transformation GitHub itself performs. Everything else a
 * name may not contain is dropped rather than substituted, so the suggestion
 * is always something `isValidRepoName` accepts.
 */
export function suggestRepoName(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/^[.]+/, "")
    .slice(0, 100);
}
