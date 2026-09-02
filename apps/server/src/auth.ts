import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { sessions, users, type Database } from "@ucch/db";
import type { Scope } from "@ucch/protocol";
import type { Config } from "./config.js";
import { hashPassword, verifyPassword } from "./password.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TICKET_TTL_MS = 5 * 60 * 1000; //             5 minutes

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

  constructor(
    private readonly db: Database,
    private readonly config: Config,
  ) {
    // Expired tickets are also rejected on use; this sweep only bounds memory.
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

    const [row] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, hashToken(token)))
      .limit(1);

    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) {
      await this.db.delete(sessions).where(eq(sessions.id, row.id));
      return null;
    }
    return { userId: row.userId, sessionId: row.id, scopes: row.scopes as Scope[] };
  }

  async revokeSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.id, hashToken(token)));
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
    if (this.config.DEV_AUTH_BYPASS && userId === DEV_USER_ID) {
      return { login: "dev", name: "Local Developer", email: null, avatarUrl: null };
    }

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

    return row ?? null;
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
          name: profile.name,
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
  }
}

/** Addresses are compared case-insensitively; the local part is lowercased too. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Fixed uuid so the bypass user is stable across restarts in development. */
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
