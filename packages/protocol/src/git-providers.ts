/**
 * The git hosts an account can be connected to.
 *
 * Plain (no zod) so the browser can import the labels from
 * `@ucch/protocol/plain`.
 */
export const GIT_PROVIDERS = ["github", "gitlab", "gitea"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export const GIT_PROVIDER_LABELS: Record<GitProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
};

/** The id of the account a GitHub sign-in stands in for, when no token is saved. */
export const GITHUB_LOGIN_ACCOUNT = "github-login";

/** One connected account, as `/api/git/accounts` reports it. Never a token. */
export interface GitAccount {
  /** A `git_accounts` id, or `GITHUB_LOGIN_ACCOUNT`. */
  id: string;
  provider: GitProvider;
  /** What its owner called it. */
  name: string;
  baseUrl: string;
  /** False when the host refused the token or could not be reached. */
  connected: boolean;
  /** The account's login on the host; null when not connected. */
  login: string | null;
}
