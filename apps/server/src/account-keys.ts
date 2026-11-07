import { and, eq, isNull, sql } from "drizzle-orm";
import { accountKeys, users, type Database } from "@ucch/db";
import { decryptSecret, encryptSecret } from "./crypto.js";

/**
 * The account's three third-party keys: what can be said about them without
 * decrypting them, the checks a new one must pass, and the one place one is
 * decrypted to be shown to its owner.
 *
 * The ciphertext stays in its `users` columns, exactly as before; this adds
 * the metadata beside it (`account_keys`). Decryption happens in two places
 * only: `reveal` here, behind the step-up in `account-keys-routes.ts`, and
 * the code that calls the provider with the key.
 */

export const ACCOUNT_KEY_PROVIDERS = ["openrouter", "resend", "github"] as const;
export type AccountKeyProvider = (typeof ACCOUNT_KEY_PROVIDERS)[number];

export function isAccountKeyProvider(value: string): value is AccountKeyProvider {
  return (ACCOUNT_KEY_PROVIDERS as readonly string[]).includes(value);
}

export const PROVIDER_NAMES: Record<AccountKeyProvider, string> = {
  openrouter: "OpenRouter",
  resend: "Resend",
  github: "GitHub",
};

/** Where each provider's ciphertext lives. */
const COLUMN = {
  openrouter: users.openrouterKeyEncrypted,
  resend: users.resendKeyEncrypted,
  github: users.githubTokenEncrypted,
} as const;

const SET = {
  openrouter: (value: string | null) => ({ openrouterKeyEncrypted: value }),
  resend: (value: string | null) => ({ resendKeyEncrypted: value }),
  github: (value: string | null) => ({ githubTokenEncrypted: value }),
} as const;

/** The non-secret leading part every key of a kind shares. */
const PREFIXES: Record<AccountKeyProvider, RegExp> = {
  openrouter: /^sk-or-(?:v\d+-)?/,
  resend: /^re_/,
  github: /^(?:github_pat_|ghp_|gho_|ghu_|ghs_)/,
};

export function keyPrefix(provider: AccountKeyProvider, key: string): string {
  return PREFIXES[provider].exec(key)?.[0] ?? "";
}

export function keyLast4(key: string): string {
  return key.slice(-4);
}

/**
 * Why a pasted key cannot be one of this provider's, or null when it could.
 * A shape check, not a validity check: that is the provider's to answer.
 */
export function checkKeyFormat(provider: AccountKeyProvider, key: string): string | null {
  if (/\s/.test(key)) return "The key contains spaces or line breaks. Paste it again without them.";
  switch (provider) {
    case "openrouter":
      return /^sk-or-[A-Za-z0-9_-]{20,}$/.test(key)
        ? null
        : "That doesn't look like an OpenRouter key. They start with sk-or-v1-.";
    case "resend":
      return /^re_[A-Za-z0-9_-]{8,}$/.test(key)
        ? null
        : "That doesn't look like a Resend key. They start with re_.";
    case "github":
      return /^(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})$/.test(key)
        ? null
        : "That doesn't look like a GitHub token. Classic tokens start with ghp_, fine-grained ones with github_pat_.";
  }
}

export type KeyCheck = { ok: true; scopes: string | null } | { ok: false; error: string };

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Asks the provider whether the key works, before it is stored.
 *
 * The messages name the provider and the HTTP status and nothing else: an
 * error body could echo the key back, so none is read into a message.
 */
export async function checkKeyLive(
  provider: AccountKeyProvider,
  key: string,
  fetchImpl: Fetch = fetch,
): Promise<KeyCheck> {
  const name = PROVIDER_NAMES[provider];
  const request: { url: string; headers: Record<string, string> } =
    provider === "openrouter"
      ? { url: "https://openrouter.ai/api/v1/key", headers: { authorization: `Bearer ${key}` } }
      : provider === "resend"
        ? { url: "https://api.resend.com/domains", headers: { authorization: `Bearer ${key}` } }
        : {
            url: "https://api.github.com/user",
            headers: {
              authorization: `Bearer ${key}`,
              accept: "application/vnd.github+json",
              "user-agent": "ucch",
              "x-github-api-version": "2022-11-28",
            },
          };

  let response: Response;
  try {
    response = await fetchImpl(request.url, { headers: request.headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return { ok: false, error: `Couldn't reach ${name} to check the key. Nothing was saved; try again in a moment.` };
  }
  // A sending-only Resend key may not list domains, and says so with a 401
  // named `restricted_api_key`. It is a real key, and sending is all the
  // harness asks of it. The one body that is read; none is ever quoted.
  if (provider === "resend" && response.status === 401 && (await restricted(response))) {
    return { ok: true, scopes: null };
  }
  void response.body?.cancel().catch(() => {});

  if (response.status === 401 || response.status === 403) {
    return { ok: false, error: `${name} rejected this key (HTTP ${response.status}). Check it was copied in full and hasn't been revoked.` };
  }
  if (response.status === 429) {
    return { ok: false, error: `${name} is rate-limiting checks right now. Nothing was saved; try again in a minute.` };
  }
  if (!response.ok) {
    return { ok: false, error: `${name} couldn't check the key (HTTP ${response.status}). Nothing was saved; try again later.` };
  }

  if (provider !== "github") return { ok: true, scopes: null };
  const header = response.headers.get("x-oauth-scopes");
  // Fine-grained tokens carry no scopes header: their permissions are per repository.
  const scopes = key.startsWith("github_pat_") || header === null ? "fine-grained" : header.trim() || "none";
  return { ok: true, scopes };
}

/** A Resend 401 for a sending-only key, which is a working key. */
async function restricted(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return body?.name === "restricted_api_key";
  } catch {
    return false;
  }
}

export interface AccountKeyMeta {
  provider: AccountKeyProvider;
  configured: boolean;
  prefix: string | null;
  last4: string | null;
  scopes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  lastRevealedAt: string | null;
}

export function unconfigured(provider: AccountKeyProvider): AccountKeyMeta {
  return {
    provider,
    configured: false,
    prefix: null,
    last4: null,
    scopes: null,
    createdAt: null,
    updatedAt: null,
    lastUsedAt: null,
    lastRevealedAt: null,
  };
}

/** What the routes need from storage; `DbAccountKeys` in the server, a Map in tests. */
export interface AccountKeyStore {
  /** Metadata for every provider, configured or not. Never a value. */
  list(userId: string): Promise<AccountKeyMeta[]>;
  /** Encrypts and stores; `replaced` says whether one was there before. */
  save(
    userId: string,
    provider: AccountKeyProvider,
    key: string,
    scopes: string | null,
  ): Promise<{ meta: AccountKeyMeta; replaced: boolean }>;
  /** False when there was nothing to remove. */
  remove(userId: string, provider: AccountKeyProvider): Promise<boolean>;
  /** The key in the clear, and `last_revealed_at` set; null when none is stored. */
  reveal(userId: string, provider: AccountKeyProvider): Promise<string | null>;
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

export class DbAccountKeys implements AccountKeyStore {
  constructor(
    private readonly db: Database,
    private readonly secretKey: string,
  ) {}

  async list(userId: string): Promise<AccountKeyMeta[]> {
    const [row] = await this.db
      .select({
        openrouter: sql<boolean>`${users.openrouterKeyEncrypted} is not null`,
        resend: sql<boolean>`${users.resendKeyEncrypted} is not null`,
        github: sql<boolean>`${users.githubTokenEncrypted} is not null`,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const metas = await this.db.select().from(accountKeys).where(eq(accountKeys.userId, userId));
    return ACCOUNT_KEY_PROVIDERS.map((provider) => {
      const meta = metas.find((m) => m.provider === provider);
      // The ciphertext is the authority on whether a key exists; a metadata
      // row without one (or the reverse, before the backfill) reads as what
      // the ciphertext says.
      if (!row?.[provider]) return unconfigured(provider);
      return {
        provider,
        configured: true,
        prefix: meta?.prefix ?? null,
        last4: meta?.last4 ?? null,
        scopes: meta?.scopes ?? null,
        createdAt: iso(meta?.createdAt),
        updatedAt: iso(meta?.updatedAt),
        lastUsedAt: iso(meta?.lastUsedAt),
        lastRevealedAt: iso(meta?.lastRevealedAt),
      };
    });
  }

  async save(userId: string, provider: AccountKeyProvider, key: string, scopes: string | null) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ value: COLUMN[provider] })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const replaced = Boolean(before?.value);
      await tx.update(users).set(SET[provider](encryptSecret(key, this.secretKey))).where(eq(users.id, userId));
      const values = {
        userId,
        provider,
        prefix: keyPrefix(provider, key),
        last4: keyLast4(key),
        scopes,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        lastRevealedAt: null,
      };
      // A replaced key is a new key: its history starts again.
      const [row] = await tx
        .insert(accountKeys)
        .values(values)
        .onConflictDoUpdate({ target: [accountKeys.userId, accountKeys.provider], set: values })
        .returning();
      const meta: AccountKeyMeta = {
        provider,
        configured: true,
        prefix: row!.prefix,
        last4: row!.last4,
        scopes: row!.scopes,
        createdAt: iso(row!.createdAt),
        updatedAt: iso(row!.updatedAt),
        lastUsedAt: null,
        lastRevealedAt: null,
      };
      return { meta, replaced };
    });
  }

  async remove(userId: string, provider: AccountKeyProvider): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const cleared = await tx
        .update(users)
        .set(SET[provider](null))
        .where(and(eq(users.id, userId), sql`${COLUMN[provider]} is not null`))
        .returning({ id: users.id });
      await tx.delete(accountKeys).where(and(eq(accountKeys.userId, userId), eq(accountKeys.provider, provider)));
      return cleared.length > 0;
    });
  }

  async reveal(userId: string, provider: AccountKeyProvider): Promise<string | null> {
    const [row] = await this.db
      .select({ value: COLUMN[provider] })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row?.value) return null;
    const key = decryptSecret(row.value, this.secretKey);
    await this.db
      .update(accountKeys)
      .set({ lastRevealedAt: new Date() })
      .where(and(eq(accountKeys.userId, userId), eq(accountKeys.provider, provider)));
    return key;
  }
}

/** At most one `last_used_at` write per key per this long. */
export const LAST_USED_DEBOUNCE_MS = 60_000;

/**
 * Records that a stored key was decrypted to call its provider.
 *
 * Debounced in memory -- a busy agent decrypts the OpenRouter key on every
 * turn -- and fire-and-forget: a failed bookkeeping write never fails the
 * call that used the key.
 */
export class KeyUsage {
  #last = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** The user's own key was used. */
  touch(userId: string, provider: AccountKeyProvider): void {
    if (!this.#due(`${userId}:${provider}`)) return;
    void this.db
      .update(accountKeys)
      .set({ lastUsedAt: new Date(this.now()) })
      .where(and(eq(accountKeys.userId, userId), eq(accountKeys.provider, provider)))
      .catch(this.onError);
  }

  /**
   * A key was used by ciphertext alone, where the caller does not know whose
   * it is -- the agent resolves a turn's key from the person or from their
   * workspace. Each encryption is unique (random IV), so the ciphertext
   * names exactly one user's key; a workspace's key matches no user and the
   * write changes nothing.
   */
  touchCiphertext(provider: AccountKeyProvider, encrypted: string | null): void {
    if (!encrypted || !this.#due(`${provider}:${encrypted.slice(-24)}`)) return;
    void this.db
      .update(accountKeys)
      .set({ lastUsedAt: new Date(this.now()) })
      .where(
        and(
          eq(accountKeys.provider, provider),
          sql`${accountKeys.userId} = (select ${users.id} from ${users} where ${COLUMN[provider]} = ${encrypted} limit 1)`,
        ),
      )
      .catch(this.onError);
  }

  #due(id: string): boolean {
    const now = this.now();
    const last = this.#last.get(id);
    if (last !== undefined && now - last < LAST_USED_DEBOUNCE_MS) return false;
    if (this.#last.size > 10_000) this.#last.clear();
    this.#last.set(id, now);
    return true;
  }
}

/**
 * Writes the metadata row for every stored key that has none: the keys saved
 * before `account_keys` existed. Decrypts each once, here on the server, to
 * read its prefix and last four; `created_at` stays null because nobody
 * recorded it. Idempotent, so it simply runs at every boot and does nothing
 * once caught up. Returns how many rows it wrote.
 */
export async function backfillAccountKeyMetadata(
  db: Database,
  secretKey: string,
  onError: (provider: AccountKeyProvider, userId: string, error: unknown) => void = () => {},
): Promise<number> {
  let written = 0;
  for (const provider of ACCOUNT_KEY_PROVIDERS) {
    const missing = await db
      .select({ id: users.id, value: COLUMN[provider] })
      .from(users)
      .leftJoin(accountKeys, and(eq(accountKeys.userId, users.id), eq(accountKeys.provider, provider)))
      .where(and(sql`${COLUMN[provider]} is not null`, isNull(accountKeys.userId)));
    for (const row of missing) {
      let key: string;
      try {
        key = decryptSecret(row.value!, secretKey);
      } catch (error) {
        // Encrypted under another SECRET_KEY: nothing can be read from it.
        onError(provider, row.id, error);
        continue;
      }
      await db
        .insert(accountKeys)
        .values({
          userId: row.id,
          provider,
          prefix: keyPrefix(provider, key),
          last4: keyLast4(key),
          scopes: provider === "github" && key.startsWith("github_pat_") ? "fine-grained" : null,
          createdAt: null,
        })
        .onConflictDoNothing();
      written++;
    }
  }
  return written;
}
