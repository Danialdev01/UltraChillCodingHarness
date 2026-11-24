import type { GitProvider } from "@ucch/protocol";

/** What git authenticates to one host with, for one command. */
export interface GitAuth {
  /** `https://host[:port]`: the only origin the token is offered to. */
  origin: string;
  username: string;
  token: string;
}

/** One connected account, decrypted only if it is the one chosen. */
export interface GitAuthSource {
  id: string;
  provider: GitProvider;
  baseUrl: string;
  login: string | null;
  /** The token in the clear; null when it cannot be decrypted. */
  token(): string | null;
}

/** Finds the credential for a URL; null when none of the owner's accounts covers it. */
export type GitAuthFor = (url: string) => GitAuth | null;

/** The name each host wants beside a token. Gitea reads the token from the password whatever it is. */
function usernameFor(source: GitAuthSource): string {
  if (source.provider === "github") return "x-access-token";
  if (source.provider === "gitlab") return "oauth2";
  return source.login ?? "git";
}

/**
 * Whether an account's token is the right credential for this URL.
 *
 * This is what keeps a token from being offered to a host it has no business
 * authenticating to: same scheme, host and port, and under the server's own
 * path. A URL that already carries credentials is left to them.
 */
export function accountCovers(baseUrl: string, repoUrl: string): boolean {
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseUrl);
    url = new URL(repoUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password) return false;
  // github.com answers on both names.
  const origin = url.origin === "https://www.github.com" ? "https://github.com" : url.origin;
  if (origin !== base.origin) return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  return !prefix || url.pathname.startsWith(`${prefix}/`);
}

/**
 * The credential for a URL: the preferred account when it covers it, else the
 * first that does (the caller lists the oldest first).
 */
export function gitAuthFor(url: string, sources: readonly GitAuthSource[], preferredId?: string | null): GitAuth | null {
  const covering = sources.filter((s) => accountCovers(s.baseUrl, url));
  const ordered = [...covering.filter((s) => s.id === preferredId), ...covering.filter((s) => s.id !== preferredId)];
  for (const source of ordered) {
    const token = source.token();
    if (token) return { origin: new URL(source.baseUrl).origin, username: usernameFor(source), token };
  }
  return null;
}
