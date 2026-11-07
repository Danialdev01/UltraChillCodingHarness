import { eq } from "drizzle-orm";
import { sessions, type Database } from "@ucch/db";

/**
 * Step-up re-authentication: proof, on this session, that whoever holds it
 * still knows the account's password. Revealing a stored key asks for one
 * within the last five minutes (`account-keys-routes.ts`).
 */

export const STEP_UP_TTL_MS = 5 * 60_000;

/** Where a session's last step-up is kept. */
export interface StepUpStore {
  mark(sessionId: string, at: Date): Promise<void>;
  /** Null when this session never stepped up. */
  get(sessionId: string): Promise<Date | null>;
}

/**
 * On the session's own row, so it ends with the session and is never in a
 * cookie. Read fresh each time rather than through the session cache: a
 * reveal is rare, and a stale "yes" here is the one answer that must not be
 * cached.
 *
 * `DEV_AUTH_BYPASS` sessions have no row; for those the step-up is held in
 * memory, which is all a local development server needs.
 */
export class DbStepUpStore implements StepUpStore {
  #memory = new Map<string, Date>();

  constructor(private readonly db: Database) {}

  async mark(sessionId: string, at: Date): Promise<void> {
    const updated = await this.db
      .update(sessions)
      .set({ stepUpAt: at })
      .where(eq(sessions.id, sessionId))
      .returning({ id: sessions.id });
    if (updated.length === 0) this.#memory.set(sessionId, at);
  }

  async get(sessionId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: sessions.stepUpAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row ? row.at : (this.#memory.get(sessionId) ?? null);
  }
}

export class MemoryStepUpStore implements StepUpStore {
  readonly #at = new Map<string, Date>();
  async mark(sessionId: string, at: Date) {
    this.#at.set(sessionId, at);
  }
  async get(sessionId: string) {
    return this.#at.get(sessionId) ?? null;
  }
}

/**
 * At most `max` hits per key in any `windowMs`. Per user rather than per
 * address (which is what `@fastify/rate-limit` keys on): a password guesser
 * holding a stolen session is one user however many addresses it uses.
 *
 * In memory, so it resets on a restart and is per process. UCCH runs as one
 * process; a restart costs a guesser a minute, not the window.
 */
export class SlidingWindow {
  #hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until another hit is allowed; 0 when one is allowed now. */
  retryAfter(key: string): number {
    const hits = this.#live(key);
    if (hits.length < this.max) return 0;
    return Math.max(1, Math.ceil((hits[0]! + this.windowMs - this.now()) / 1000));
  }

  hit(key: string): void {
    const hits = this.#live(key);
    hits.push(this.now());
    this.#hits.set(key, hits);
  }

  clear(key: string): void {
    this.#hits.delete(key);
  }

  #live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);
    if (hits.length === 0) this.#hits.delete(key);
    else this.#hits.set(key, hits);
    return hits;
  }
}
