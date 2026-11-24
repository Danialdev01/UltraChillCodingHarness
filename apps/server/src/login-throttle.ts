import { createHash } from "node:crypto";

/** Failures one account may collect from unknown addresses before they are made to wait. */
const MAX_FAILURES = 30;
const WINDOW_MS = 15 * 60_000;
/** Accounts, and known addresses per account, remembered at once. */
const MAX_ACCOUNTS = 10_000;
const MAX_KNOWN = 20;

/**
 * A brake on guessing one account's password from many addresses, beside the
 * per-address limit on the route.
 *
 * Never a lockout of the owner: an address that has signed in to the account
 * is not held back by what others do, and the count runs out by itself. Kept
 * in memory -- a restart forgetting it costs a guesser nothing it can plan on.
 */
export class LoginThrottle {
  #failures = new Map<string, { count: number; until: number }>();
  #known = new Map<string, Set<string>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Seconds this address must wait before trying the account, or 0. */
  retryAfter(email: string, address: string): number {
    const key = keyOf(email);
    if (this.#known.get(key)?.has(address)) return 0;
    const entry = this.#failures.get(key);
    if (!entry || entry.until <= this.now() || entry.count < MAX_FAILURES) return 0;
    return Math.ceil((entry.until - this.now()) / 1000);
  }

  failed(email: string, address: string): void {
    const key = keyOf(email);
    if (this.#known.get(key)?.has(address)) return;
    const entry = this.#failures.get(key);
    if (entry && entry.until > this.now()) {
      entry.count++;
      return;
    }
    this.#failures.delete(key);
    bound(this.#failures);
    this.#failures.set(key, { count: 1, until: this.now() + WINDOW_MS });
  }

  succeeded(email: string, address: string): void {
    const key = keyOf(email);
    const known = this.#known.get(key) ?? new Set<string>();
    known.delete(address);
    known.add(address);
    if (known.size > MAX_KNOWN) known.delete(known.values().next().value!);
    this.#known.delete(key);
    bound(this.#known);
    this.#known.set(key, known);
  }
}

function bound(map: Map<string, unknown>): void {
  while (map.size >= MAX_ACCOUNTS) map.delete(map.keys().next().value!);
}

/** The address as sign-in compares it; hashed so a long one costs nothing to keep. */
function keyOf(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("base64url");
}
