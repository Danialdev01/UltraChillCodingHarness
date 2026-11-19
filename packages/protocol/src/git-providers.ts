/**
 * The git hosts an account can be connected to.
 *
 * Plain (no zod) so the browser can import the labels from
 * `@ucch/protocol/plain`. Only GitHub has an integration today; GitLab and
 * Gitea are listed so the dialog and the accounts route have a place for them.
 */
export const GIT_PROVIDERS = ["github", "gitlab", "gitea"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export const GIT_PROVIDER_LABELS: Record<GitProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
};

/** One connected (or connectable) account, as `/api/git/accounts` reports it. */
export interface GitAccount {
  provider: GitProvider;
  connected: boolean;
  /** The account's login; null when not connected. */
  login: string | null;
  name: string | null;
  /** Whether this provider is integrated yet: false shows as "Coming soon". */
  available: boolean;
}
