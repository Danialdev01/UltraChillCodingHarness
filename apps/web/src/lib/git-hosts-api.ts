/**
 * Git hosts, as the new-project dialog sees them.
 *
 * A token never reaches the browser: these call the harness, which holds the
 * account's tokens and talks to GitHub, GitLab and Gitea itself. A repository
 * is its full path, since GitLab's can be several groups deep.
 */

import type { GitAccount, GitProvider } from "@ucch/protocol";

/** Mirrors the server's `GitRepo`. */
export interface HostRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  description: string | null;
  pushedAt: string | null;
}

/** A repository from any connected account, tagged with where it came from. */
export interface GitRepo extends HostRepo {
  provider: GitProvider;
  accountId: string;
  accountName: string;
}

export interface GitRepoAccount {
  id: string;
  provider: GitProvider;
  name: string;
  login: string;
}

/** One connected account's repositories failing, reported beside the rest. */
export interface GitReposError {
  accountId: string;
  provider: GitProvider;
  name: string;
  error: string;
}

/** Somewhere a repository can be created: the account, or an organisation or group. */
export interface GitOwner {
  login: string;
  kind: "user" | "org";
}

async function call<T>(path: string, fallback: string, post?: unknown): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...(post !== undefined
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(post) }
      : {}),
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? fallback);
  return body;
}

const account = (id: string) => `/api/git/accounts/${encodeURIComponent(id)}`;

/**
 * Every connected account's repositories, as one list.
 *
 * No account connected is an empty list rather than an error: the Git tab
 * still takes a pasted URL without one.
 */
export function fetchGitRepos() {
  return call<{ accounts: GitRepoAccount[]; repos: GitRepo[]; errors: GitReposError[] }>(
    "/api/git/repos",
    "Could not read your repositories.",
  );
}

/** Every connected account, and whether its host still accepts it. */
export async function fetchGitAccounts(): Promise<GitAccount[]> {
  return (await call<{ accounts: GitAccount[] }>("/api/git/accounts", "Could not read your git accounts.")).accounts;
}

/** Where an account can create repositories, the account itself first. */
export async function fetchOwners(accountId: string): Promise<GitOwner[]> {
  const path = `${account(accountId)}/owners`;
  return (await call<{ owners: GitOwner[] }>(path, "Could not read where you can create repositories.")).owners;
}

export interface CreateRepoInput {
  owner: string;
  name: string;
  private: boolean;
  autoInit: boolean;
}

/** Creates a repository, answered as the repository list would show it. */
export async function createRepo(accountId: string, input: CreateRepoInput): Promise<HostRepo> {
  return (await call<{ repo: HostRepo }>(`${account(accountId)}/repos`, "Could not create the repository.", input)).repo;
}

/** One repository's branches, and the one it defaults to. Works for a private one. */
export function fetchBranches(accountId: string, fullName: string) {
  return call<{ branches: string[]; defaultBranch: string | null }>(
    `${account(accountId)}/branches?repo=${encodeURIComponent(fullName)}`,
    `Could not read the branches of ${fullName}.`,
  );
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
