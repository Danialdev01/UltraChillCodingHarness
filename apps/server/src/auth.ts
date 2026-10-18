import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { sessions, users, type Database } from "@ucch/db";
import { isAvatarDataUrl, type Scope } from "@ucch/protocol";
import type { Config } from "./config.js";
import { hashPassword, verifyPassword } from "./password.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TICKET_TTL_MS = 5 * 60 * 1000; //             5 minutes
const SESSION_CACHE_MS = 15 * 1000; //             15 seconds
const SESSION_CACHE_MAX = 10_000;

export interface Principal {
  userId: string;
  sessionId: string;
  scopes: Scope[];
}

/**
 * Sessions live in Postgres; WebSocket tickets live in memory.
 *
 * The split is deliberate. A browser cannot set an Authorization header on a
 * WebSocket handshake, and putting a long-lived session token in the query
 * string would leak it into proxy logs and Referer headers. Instead the client
 * exchanges its session cookie for a short-lived single-use ticket over HTTPS
 * and spends that on the upgrade. Tickets are ephemeral by nature, so losing
 * them on restart is correct rather than a limitation.
 */
export class AuthService {
  #tickets = new Map<string, { principal: Principal; expiresAt: number }>();

  /**
   * Recently resolved sessions, by hashed id.
   *
   * Every API request resolves its cookie, and a page load is a dozen
   * requests; without this each one was a round trip to Postgres for the
   * same row. Every way a session ends goes through this class and drops
   * its entry, so the window in which a revoked session still works is
   * zero on this process -- the TTL only bounds how stale an entry can get
   * if a row is deleted from outside it.
   */
  #sessionCache = new Map<string, { principal: Principal; expiresAt: number; cachedUntil: number }>();

  constructor(
    private readonly db: Database,
    private readonly config: Config,
  ) {
    // Expired tickets and cached sessions are also rejected on use; this
    // sweep only bounds memory.
    setInterval(() => this.#sweep(), 60_000).unref();
  }

  async createSession(userId: string, scopes: Scope[]): Promise<string> {
    const id = randomBytes(32).toString("base64url");
    await this.db.insert(sessions).values({
      id: hashToken(id),
      userId,
      scopes,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return id;
  }

  async resolveSession(token: string | undefined): Promise<Principal | null> {
    if (this.config.DEV_AUTH_BYPASS) return this.#devPrincipal();
    if (!token) return null;

    const id = hashToken(token);
    const now = Date.now();
    const cached = this.#sessionCache.get(id);
    if (cached && cached.cachedUntil > now && cached.expiresAt > now) return cached.principal;
    this.#sessionCache.delete(id);

    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);

    if (!row) return null;
    if (row.expiresAt.getTime() < now) {
      await this.db.delete(sessions).where(eq(sessions.id, row.id));
      return null;
    }
    const principal = { userId: row.userId, sessionId: row.id, scopes: row.scopes as Scope[] };
    if (this.#sessionCache.size >= SESSION_CACHE_MAX) this.#sessionCache.clear();
    this.#sessionCache.set(id, { principal, expiresAt: row.expiresAt.getTime(), cachedUntil: now + SESSION_CACHE_MS });
    return principal;
  }

  /** Deletes every expired session; returns how many went. */
  async sweepExpiredSessions(now = new Date()): Promise<number> {
    const removed = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning({ id: sessions.id });
    return removed.length;
  }

  /** Ends a session; returns its id, which is what its sockets' principals carry. */
  async revokeSession(token: string): Promise<string> {
    const id = hashToken(token);
    this.#sessionCache.delete(id);
    await this.db.delete(sessions).where(eq(sessions.id, id));
    return id;
  }

  issueTicket(principal: Principal): { ticket: string; expiresInMs: number } {
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { principal, expiresAt: Date.now() + TICKET_TTL_MS });
    return { ticket, expiresInMs: TICKET_TTL_MS };
  }

  /** Single-use: the ticket is consumed whether or not it turns out to be valid. */
  redeemTicket(ticket: string | undefined): Principal | null {
    if (this.config.DEV_AUTH_BYPASS) return this.#devPrincipal();
    if (!ticket) return null;

    const entry = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) return null;
    return entry.principal;
  }

  /**
   * Verifies an email/password pair.
   *
   * Returns null for both "no such user" and "wrong password", and spends the
   * hashing work either way -- distinguishing the two would let an
   * unauthenticated caller enumerate registered addresses.
   */
  /**
   * Display fields for the signed-in user. Deliberately narrow: the password
   * hash and the encrypted GitHub token are never selected, so they cannot
   * reach a response by accident.
   */
  async getProfile(userId: string): Promise<{
    login: string;
    name: string | null;
    email: string | null;
    avatarUrl: string | null;
  } | null> {
    const [row] = await this.db
      .select({
        login: users.login,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    // The bypass user is a real row -- it is inserted at boot, because
    // projects carry a foreign key to it -- so it is read like any other and
    // only stood in for when it is genuinely missing. Returning a hardcoded
    // profile here instead meant every edit on the settings page saved and
    // then vanished: the row changed and the response did not.
    if (row) return row;
    if (this.config.DEV_AUTH_BYPASS && userId === DEV_USER_ID) {
      return { login: "dev", name: "Local Developer", email: null, avatarUrl: null };
    }
    return null;
  }

/**
   * Changes the display name -- what the sidebar and every profile menu show.
   *
   * No password is asked for, unlike the email: a name is not a credential,
   * and changing it cannot be used to take an account over. It is stored
   * trimmed, and an empty name is stored as null so the display falls back
   * to the login rather than rendering a blank row.
   */
  async updateName(
    userId: string,
    name: string,
  ): Promise<{ name: string | null } | { error: "not_found" }> {
    const trimmed = name.trim();
    const stored = trimmed.length > 0 ? trimmed : null;

    const [row] = await this.db
      .update(users)
      .set({ name: stored })
      .where(eq(users.id, userId))
      .returning({ name: users.name });

    if (!row) return { error: "not_found" };
    return { name: row.name };
  }

  /**
   * Changes the address the account signs in with.
   *
   * The current password is required whenever the account has one. Holding a
   * session is not enough on its own: the email *is* the login identifier,
   * and an unattended browser could otherwise be used to take an account
   * over silently. An account that signs in through GitHub alone has no
   * password to ask for, so it is asked for nothing.
   */
  async updateEmail(
    userId: string,
    email: string,
    currentPassword: string | null,
  ): Promise<{ email: string } | { error: "wrong_password" | "taken" | "not_found" }> {
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return { error: "not_found" };

    if (row.passwordHash) {
      const valid = await verifyPassword(currentPassword ?? "", row.passwordHash);
      if (!valid) return { error: "wrong_password" };
    }

    const normalized = normalizeEmail(email);
    try {
      await this.db.update(users).set({ email: normalized }).where(eq(users.id, userId));
      return { email: normalized };
    } catch (error) {
      // The unique index is the authority on whether an address is free: a
      // select first would leave a window in which two accounts both saw it
      // as available.
      if (isUniqueViolation(error)) return { error: "taken" };
      throw error;
    }
  }

  /**
   * Sets a new password, or adds the first one to a GitHub-only account.
   *
   * Every other session is revoked on success, and this one is not. Changing
   * a password is what someone does when they think it is known, and leaving
   * the sessions it protects alive would make the change cosmetic.
   */
  async changePassword(
    userId: string,
    currentPassword: string | null,
    newPassword: string,
    keepSessionId: string,
  ): Promise<{ ok: true; hadPassword: boolean } | { error: "wrong_password" | "not_found" }> {
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return { error: "not_found" };

    if (row.passwordHash) {
      const valid = await verifyPassword(currentPassword ?? "", row.passwordHash);
      if (!valid) return { error: "wrong_password" };
    }

    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(newPassword) })
      .where(eq(users.id, userId));

    await this.db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
    for (const [id, entry] of this.#sessionCache) {
      if (entry.principal.userId === userId && id !== keepSessionId) this.#sessionCache.delete(id);
    }

    return { ok: true, hadPassword: row.passwordHash !== null };
  }

  /**
   * Stores or clears the profile picture.
   *
   * The value is checked against `isAvatarDataUrl` here as well as in the
   * browser, because the browser's copy is a convenience and this one is the
   * rule: it is what stops an arbitrary URL -- or an SVG, which can carry
   * script -- being written into a column every page renders into an `img`.
   */
  async updateAvatar(userId: string, dataUrl: string | null): Promise<boolean> {
    if (dataUrl !== null && !isAvatarDataUrl(dataUrl)) return false;
    await this.db.update(users).set({ avatarUrl: dataUrl }).where(eq(users.id, userId));
    return true;
  }

  /** Whether the account can sign in with a password at all. */
  async hasPassword(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return Boolean(row?.passwordHash);
  }

    async verifyCredentials(email: string, password: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .limit(1);

    const valid = await verifyPassword(password, row?.passwordHash ?? null);
    return valid && row ? row.id : null;
  }

  /**
   * Creates the account if the email is unused, otherwise leaves it alone.
   * Called on boot for the default user, so it must never overwrite a
   * password that has since been changed.
   */
  async ensurePasswordUser(profile: {
    email: string;
    password: string;
    login: string;
    name: string;
  }): Promise<{ id: string; created: boolean }> {
    const email = normalizeEmail(profile.email);

    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing) return { id: existing.id, created: false };

    const [row] = await this.db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(profile.password),
        login: profile.login,
        name: profile.name,
      })
      // A concurrent boot could insert the same row between the select and
      // here; take whichever landed first rather than failing to start.
      .onConflictDoUpdate({ target: users.email, set: { email: sql`excluded.email` } })
      .returning({ id: users.id });

    return { id: row!.id, created: true };
  }

  /** Whether a GitHub identity already has an account here. */
  async hasGithubUser(githubId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.githubId, githubId))
      .limit(1);
    return Boolean(row);
  }

  async upsertGithubUser(profile: {
    githubId: string;
    login: string;
    name: string | null;
    avatarUrl: string | null;
    accessTokenEncrypted: string;
  }): Promise<string> {
    const [row] = await this.db
      .insert(users)
      .values(profile)
      .onConflictDoUpdate({
        target: users.githubId,
        set: {
          login: profile.login,
          // Whatever the account already has wins: a name edited in Settings
          // must not be undone by the next sign-in. GitHub's own name still
          // fills an account that has never had one.
          name: sql`coalesce(${users.name}, excluded.name)`,
          avatarUrl: profile.avatarUrl,
          accessTokenEncrypted: profile.accessTokenEncrypted,
        },
      })
      .returning({ id: users.id });

    return row!.id;
  }

  #devPrincipal(): Principal {
    return {
      userId: DEV_USER_ID,
      sessionId: "dev",
      scopes: ["read", "write", "exec", "admin"],
    };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [ticket, entry] of this.#tickets) {
      if (entry.expiresAt < now) this.#tickets.delete(ticket);
    }
    for (const [id, entry] of this.#sessionCache) {
      if (entry.cachedUntil < now) this.#sessionCache.delete(id);
    }
  }
}

/** Addresses are compared case-insensitively; the local part is lowercased too. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Fixed uuid so the bypass user is stable across restarts in development. */
/**
 * Whether a database error is a unique-index conflict.
 *
 * Postgres reports these as SQLSTATE 23505. Matched on the code rather than
 * the message, which is localised and names the index.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Session tokens are stored hashed, so a database leak does not hand over
 * live sessions.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
