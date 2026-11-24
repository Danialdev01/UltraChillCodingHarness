import { and, asc, eq } from "drizzle-orm";
import { gitAccounts, type Database } from "@ucch/db";
import { GIT_PROVIDERS, GIT_PROVIDER_LABELS, type GitProvider } from "@ucch/protocol";
import { LAST_USED_DEBOUNCE_MS, keyLast4 } from "./account-keys.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import type { GitAuthSource } from "./git-auth.js";
import { GIT_HOSTS, GitHostError, type FetchLike } from "./git-hosts/index.js";

/**
 * The git accounts a person connects: any number per provider, each named by
 * its owner. A token is decrypted to call its host or to run git, and never
 * goes back to a browser; replacing one is the only way to change it.
 */

export const GITHUB_URL = "https://github.com";

/** Where each provider lives when the person does not say; Gitea has no such place. */
export const DEFAULT_BASE_URL: Record<GitProvider, string | null> = {
  github: GITHUB_URL,
  gitlab: "https://gitlab.com",
  gitea: null,
};

const PREFIXES: Record<GitProvider, RegExp | null> = {
  github: /^(?:github_pat_|ghp_|gho_|ghu_|ghs_)/,
  gitlab: /^glpat-/,
  gitea: null,
};

export function isGitProvider(value: string): value is GitProvider {
  return (GIT_PROVIDERS as readonly string[]).includes(value);
}

export function tokenPrefix(provider: GitProvider, token: string): string {
  return PREFIXES[provider]?.exec(token)?.[0] ?? "";
}

/** Why a pasted token cannot be one, or null. Self-hosted servers choose their own shapes. */
export function checkTokenFormat(provider: GitProvider, token: string): string | null {
  // Also keeps control characters out of the credential helper's line protocol.
  if (!/^[\x21-\x7e]+$/.test(token)) return "The token contains spaces, line breaks or odd characters. Paste it again without them.";
  if (provider === "github" && !/^(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})$/.test(token)) {
    return "That doesn't look like a GitHub token. Classic tokens start with ghp_, fine-grained ones with github_pat_.";
  }
  return null;
}

export type TokenCheck = { ok: true; login: string; scopes: string | null } | { ok: false; error: string };

/** Asks the host whose token it is, before it is stored. */
export async function checkTokenLive(
  provider: GitProvider,
  baseUrl: string,
  token: string,
  fetch: FetchLike,
): Promise<TokenCheck> {
  try {
    const { login, scopes } = await GIT_HOSTS[provider].identify({ baseUrl, token, fetch });
    // A login becomes git's username, which is a line in its helper protocol.
    if (!/^[\x21-\x7e]+$/.test(login)) return { ok: false, error: `${GIT_PROVIDER_LABELS[provider]} answered an unusable login.` };
    return { ok: true, login, scopes };
  } catch (error) {
    if (!(error instanceof GitHostError)) throw error;
    if (error.status === 401) {
      return { ok: false, error: `${GIT_PROVIDER_LABELS[provider]} rejected this token. Check it was copied in full and hasn't been revoked.` };
    }
    return { ok: false, error: `${error.message} Nothing was saved.` };
  }
}

export interface GitAccountMeta {
  id: string;
  provider: GitProvider;
  name: string;
  baseUrl: string;
  login: string | null;
  prefix: string;
  last4: string;
  scopes: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface NewGitAccount {
  provider: GitProvider;
  name: string;
  baseUrl: string;
  token: string;
  login: string | null;
  scopes: string | null;
}

export interface GitAccountStore {
  /** Oldest first. Never a token. */
  list(userId: string): Promise<GitAccountMeta[]>;
  create(userId: string, input: NewGitAccount): Promise<GitAccountMeta>;
  rename(userId: string, id: string, name: string): Promise<GitAccountMeta | null>;
  replaceToken(userId: string, id: string, token: string, login: string | null, scopes: string | null): Promise<GitAccountMeta | null>;
  remove(userId: string, id: string): Promise<boolean>;
}

export class DuplicateAccountName extends Error {
  constructor(name: string) {
    super(`You already have a git account called "${name}". Pick another name.`);
  }
}

type Row = typeof gitAccounts.$inferSelect;

function toMeta(row: Row): GitAccountMeta {
  return {
    id: row.id,
    provider: row.provider as GitProvider,
    name: row.name,
    baseUrl: row.baseUrl,
    login: row.login,
    prefix: row.prefix,
    last4: row.last4,
    scopes: row.scopes,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

async function unique<T>(name: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") throw new DuplicateAccountName(name);
    throw error;
  }
}

export class DbGitAccounts implements GitAccountStore {
  #touched = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly secretKey: string,
  ) {}

  async #rows(userId: string): Promise<Row[]> {
    const rows = await this.db
      .select()
      .from(gitAccounts)
      .where(eq(gitAccounts.userId, userId))
      .orderBy(asc(gitAccounts.createdAt), asc(gitAccounts.id));
    return rows.filter((row) => isGitProvider(row.provider));
  }

  async list(userId: string) {
    return (await this.#rows(userId)).map(toMeta);
  }

  /** The accounts as credentials: each decrypts, and counts as used, only when its token is asked for. */
  async sources(userId: string): Promise<(GitAuthSource & { name: string })[]> {
    return (await this.#rows(userId)).map((row) => ({
      id: row.id,
      provider: row.provider as GitProvider,
      name: row.name,
      baseUrl: row.baseUrl,
      login: row.login,
      token: () => {
        try {
          const token = decryptSecret(row.tokenEncrypted, this.secretKey);
          this.#touch(row.id);
          return token;
        } catch {
          // Encrypted under another SECRET_KEY.
          return null;
        }
      },
    }));
  }

  #touch(id: string): void {
    const now = Date.now();
    if (now - (this.#touched.get(id) ?? 0) < LAST_USED_DEBOUNCE_MS) return;
    if (this.#touched.size > 10_000) this.#touched.clear();
    this.#touched.set(id, now);
    void this.db.update(gitAccounts).set({ lastUsedAt: new Date(now) }).where(eq(gitAccounts.id, id)).catch(() => {});
  }

  /** Fills in a login that was not known: a token moved from before accounts had one. */
  learnLogin(id: string, login: string): void {
    void this.db.update(gitAccounts).set({ login }).where(eq(gitAccounts.id, id)).catch(() => {});
  }

  #secret(provider: GitProvider, token: string) {
    return {
      tokenEncrypted: encryptSecret(token, this.secretKey),
      prefix: tokenPrefix(provider, token),
      last4: keyLast4(token),
    };
  }

  async create(userId: string, { token, ...input }: NewGitAccount) {
    const [row] = await unique(
      input.name,
      this.db
        .insert(gitAccounts)
        .values({ userId, ...input, ...this.#secret(input.provider, token) })
        .returning()
        .execute(),
    );
    return toMeta(row!);
  }

  async rename(userId: string, id: string, name: string) {
    const [row] = await unique(
      name,
      this.db
        .update(gitAccounts)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(gitAccounts.id, id), eq(gitAccounts.userId, userId)))
        .returning()
        .execute(),
    );
    return row ? toMeta(row) : null;
  }

  async replaceToken(userId: string, id: string, token: string, login: string | null, scopes: string | null) {
    const mine = and(eq(gitAccounts.id, id), eq(gitAccounts.userId, userId));
    const [before] = await this.db.select().from(gitAccounts).where(mine).limit(1);
    if (!before) return null;
    const [row] = await this.db
      .update(gitAccounts)
      .set({ ...this.#secret(before.provider as GitProvider, token), login, scopes, lastUsedAt: null, updatedAt: new Date() })
      .where(mine)
      .returning();
    return row ? toMeta(row) : null;
  }

  async remove(userId: string, id: string) {
    const removed = await this.db
      .delete(gitAccounts)
      .where(and(eq(gitAccounts.id, id), eq(gitAccounts.userId, userId)))
      .returning({ id: gitAccounts.id });
    return removed.length > 0;
  }
}
