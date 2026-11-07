import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PROVIDER_NAMES,
  checkKeyFormat,
  isAccountKeyProvider,
  keyLast4,
  unconfigured,
  type AccountKeyProvider,
  type AccountKeyStore,
  type KeyCheck,
} from "./account-keys.js";
import { STEP_UP_TTL_MS, SlidingWindow, type StepUpStore } from "./step-up.js";

/**
 * The API keys page's routes.
 *
 *   GET    /api/account/keys                   metadata only, never a value
 *   PUT    /api/account/keys/:provider         format check, live check, store
 *   DELETE /api/account/keys/:provider
 *   POST   /api/account/reauth                 password -> step-up, five minutes
 *   POST   /api/account/keys/:provider/reveal  the one route that returns a key
 *
 * plus the older `PUT /api/settings/:provider`, kept for scripts.
 *
 * A key leaves the server through `/reveal` alone, and only for a session
 * that re-entered its password in the last five minutes. Every reveal and
 * copy is written to the account's Activity, with the key in none of it.
 */

/** How long a revealed key stays on screen before the page hides it. */
export const REVEAL_SECONDS = 30;
/**
 * How long after a GitHub-only account adds its first password before that
 * password can unlock a key. Adding one needs only the session, so without
 * this a stolen session could set a password and then pass its own step-up.
 */
export const FIRST_PASSWORD_GRACE_MS = 60 * 60_000;

export const REAUTH_LIMIT = { max: 5, windowMs: 10 * 60_000 };
export const REVEAL_LIMIT = { max: 10, windowMs: 10 * 60_000 };

export interface KeyAuditEntry {
  userId: string;
  action: "api_key.created" | "api_key.replaced" | "api_key.removed" | "api_key.revealed" | "api_key.copied";
  provider: AccountKeyProvider;
  summary: string;
  details: Record<string, unknown>;
}

export interface AccountKeyRouteDeps {
  principal(request: FastifyRequest): Promise<{ userId: string; sessionId: string } | null>;
  keys: AccountKeyStore;
  /** False without `SECRET_KEY`: nothing can be stored or revealed. */
  encryptionAvailable: boolean;
  /** Asks the provider whether a key works. */
  check(provider: AccountKeyProvider, key: string): Promise<KeyCheck>;
  password: {
    check(userId: string, password: string): Promise<"ok" | "wrong" | "none">;
    state(userId: string): Promise<{ hasPassword: boolean; addedAt: Date | null }>;
  };
  stepUp: StepUpStore;
  audit(entry: KeyAuditEntry): Promise<void>;
  /** Whether signing in with GitHub left a token the repository list can fall back to. */
  githubFromLogin?(userId: string): Promise<boolean>;
  /** A key was stored or removed: refresh caches, tell other tabs. */
  changed?(userId: string, provider: AccountKeyProvider): void;
  now?: () => number;
}

const SaveBody = z.object({ key: z.string().max(400) });
const RevealBody = z.object({ purpose: z.enum(["reveal", "copy"]).optional() }).optional();
const ReauthBody = z.object({ password: z.string().min(1).max(1024) });
/** The older settings route: `null` removes. */
const LegacyBody = z.object({ apiKey: z.string().trim().min(1).max(400).nullable() });

const NO_SECRET_KEY = "SECRET_KEY is not configured on the server, so keys cannot be stored or revealed.";

export function registerAccountKeyRoutes(app: FastifyInstance, deps: AccountKeyRouteDeps): void {
  const now = deps.now ?? Date.now;
  const reauthLimit = new SlidingWindow(REAUTH_LIMIT.max, REAUTH_LIMIT.windowMs, now);
  const revealLimit = new SlidingWindow(REVEAL_LIMIT.max, REVEAL_LIMIT.windowMs, now);

  const who = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: String(request.headers["user-agent"] ?? "").slice(0, 300) || null,
  });

  /** Whether this account may step up at all, and if not, the reply that says why. */
  async function passwordGate(userId: string): Promise<{ code: string; error: string; retryAfterSeconds?: number } | null> {
    const state = await deps.password.state(userId);
    if (!state.hasPassword) {
      return {
        code: "PASSWORD_REQUIRED",
        error: "Revealing a key needs a password on your account. Set one under Account, then try again.",
      };
    }
    if (state.addedAt) {
      const wait = state.addedAt.getTime() + FIRST_PASSWORD_GRACE_MS - now();
      if (wait > 0) {
        return {
          code: "PASSWORD_TOO_NEW",
          error: `Your password was added recently. For your security, keys can be revealed with it in ${minutes(wait / 1000)}.`,
          retryAfterSeconds: Math.ceil(wait / 1000),
        };
      }
    }
    return null;
  }

  app.get("/api/account/keys", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const [keys, gate, stepUpAt, githubFromLogin] = await Promise.all([
      deps.keys.list(principal.userId),
      passwordGate(principal.userId),
      deps.stepUp.get(principal.sessionId),
      deps.githubFromLogin?.(principal.userId) ?? false,
    ]);
    const stepUpLeft = stepUpAt ? stepUpAt.getTime() + STEP_UP_TTL_MS - now() : 0;
    return {
      keys,
      encryptionAvailable: deps.encryptionAvailable,
      // Why Reveal would be refused before a password is even asked for.
      reveal: gate ? { available: false, code: gate.code, reason: gate.error } : { available: true },
      stepUpExpiresInSeconds: stepUpLeft > 0 ? Math.floor(stepUpLeft / 1000) : 0,
      githubFromLogin,
    };
  });

  app.post("/api/account/reauth", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const parsed = ReauthBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Enter your password." });

    const wait = reauthLimit.retryAfter(principal.userId);
    if (wait > 0) {
      return reply
        .code(429)
        .header("retry-after", String(wait))
        .send({ error: `Too many attempts. Try again in ${minutes(wait)}.`, retryAfterSeconds: wait });
    }

    const result = await deps.password.check(principal.userId, parsed.data.password);
    if (result === "none") {
      return reply.code(409).send({
        code: "PASSWORD_REQUIRED",
        error: "Your account has no password. Set one under Account, then try again.",
      });
    }
    if (result === "wrong") {
      reauthLimit.hit(principal.userId);
      // Generic on purpose: the same words whatever was wrong.
      return reply.code(401).send({ error: "That password isn't right." });
    }
    reauthLimit.clear(principal.userId);
    await deps.stepUp.mark(principal.sessionId, new Date(now()));
    return { expiresInSeconds: STEP_UP_TTL_MS / 1000 };
  });

  app.post<{ Params: { provider: string } }>("/api/account/keys/:provider/reveal", async (request, reply) => {
    // Set first, so even a refusal is never cached anywhere.
    reply.header("cache-control", "no-store, max-age=0").header("pragma", "no-cache");

    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const provider = request.params.provider;
    if (!isAccountKeyProvider(provider)) return reply.code(404).send({ error: "unknown provider" });
    if (!deps.encryptionAvailable) return reply.code(409).send({ error: NO_SECRET_KEY });
    const parsed = RevealBody.safeParse(request.body ?? undefined);
    if (!parsed.success) return reply.code(400).send({ error: "purpose must be reveal or copy" });
    const purpose = parsed.data?.purpose ?? "reveal";

    const gate = await passwordGate(principal.userId);
    if (gate) return reply.code(403).send(gate);

    const stepUpAt = await deps.stepUp.get(principal.sessionId);
    if (!stepUpAt || now() - stepUpAt.getTime() > STEP_UP_TTL_MS) {
      return reply.code(403).send({ code: "REAUTH_REQUIRED", error: "Confirm your password to continue." });
    }

    const wait = revealLimit.retryAfter(principal.userId);
    if (wait > 0) {
      return reply
        .code(429)
        .header("retry-after", String(wait))
        .send({ error: `Too many reveals. Try again in ${minutes(wait)}.`, retryAfterSeconds: wait });
    }

    // Only the signed-in user's own key is ever addressed: there is no user
    // in the URL to point at anyone else's.
    const key = await deps.keys.reveal(principal.userId, provider);
    if (key === null) return reply.code(404).send({ error: `No ${PROVIDER_NAMES[provider]} key is stored.` });
    revealLimit.hit(principal.userId);

    const name = PROVIDER_NAMES[provider];
    await deps.audit({
      userId: principal.userId,
      action: purpose === "copy" ? "api_key.copied" : "api_key.revealed",
      provider,
      summary: purpose === "copy" ? `Copied the ${name} key` : `Revealed the ${name} key`,
      details: { provider, ...who(request), at: new Date(now()).toISOString() },
    });
    return { key, expiresInSeconds: REVEAL_SECONDS };
  });

  app.put<{ Params: { provider: string } }>("/api/account/keys/:provider", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const provider = request.params.provider;
    if (!isAccountKeyProvider(provider)) return reply.code(404).send({ error: "unknown provider" });
    if (!deps.encryptionAvailable) return reply.code(409).send({ error: NO_SECRET_KEY });
    const parsed = SaveBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Paste a key." });

    const key = parsed.data.key.trim();
    if (!key) return reply.code(400).send({ error: "Paste a key." });
    const formatError = checkKeyFormat(provider, key);
    if (formatError) return reply.code(400).send({ error: formatError });

    const check = await deps.check(provider, key);
    if (!check.ok) return reply.code(422).send({ error: check.error });

    return { key: await store(principal.userId, provider, key, check.scopes, request) };
  });

  app.delete<{ Params: { provider: string } }>("/api/account/keys/:provider", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const provider = request.params.provider;
    if (!isAccountKeyProvider(provider)) return reply.code(404).send({ error: "unknown provider" });
    const removed = await deps.keys.remove(principal.userId, provider);
    if (!removed) return reply.code(404).send({ error: `No ${PROVIDER_NAMES[provider]} key is stored.` });
    await deps.audit({
      userId: principal.userId,
      action: "api_key.removed",
      provider,
      summary: `Removed the ${PROVIDER_NAMES[provider]} key`,
      details: { provider, ...who(request) },
    });
    deps.changed?.(principal.userId, provider);
    return { key: unconfigured(provider) };
  });

  /**
   * The older route the page used before this one, kept because scripts call
   * it (the load-test seed stores a mock key). It skips the live check -- a
   * script's key need not be real -- but nothing else: the same storage,
   * metadata and Activity entry.
   */
  for (const provider of ["openrouter", "resend", "github"] as const) {
    app.put(`/api/settings/${provider}`, async (request, reply) => {
      const principal = await deps.principal(request);
      if (!principal) return reply.code(401).send({ error: "unauthorized" });
      const parsed = LegacyBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "an api key or null is required" });
      if (parsed.data.apiKey === null) {
        const removed = await deps.keys.remove(principal.userId, provider);
        if (removed) {
          await deps.audit({
            userId: principal.userId,
            action: "api_key.removed",
            provider,
            summary: `Removed the ${PROVIDER_NAMES[provider]} key`,
            details: { provider, ...who(request) },
          });
          deps.changed?.(principal.userId, provider);
        }
        return { [provider]: { configured: false, hint: null } };
      }
      if (!deps.encryptionAvailable) return reply.code(409).send({ error: NO_SECRET_KEY });
      const key = parsed.data.apiKey;
      await store(principal.userId, provider, key, null, request);
      return { [provider]: { configured: true, hint: keyLast4(key) } };
    });
  }

  async function store(
    userId: string,
    provider: AccountKeyProvider,
    key: string,
    scopes: string | null,
    request: FastifyRequest,
  ) {
    const { meta, replaced } = await deps.keys.save(userId, provider, key, scopes);
    const name = PROVIDER_NAMES[provider];
    await deps.audit({
      userId,
      action: replaced ? "api_key.replaced" : "api_key.created",
      provider,
      summary: replaced ? `Replaced the ${name} key` : `Added the ${name} key`,
      details: { provider, ...who(request), ...(scopes ? { scopes } : {}) },
    });
    deps.changed?.(userId, provider);
    return meta;
  }
}

/** "4 minutes", "1 minute", never "0 minutes". */
function minutes(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return `${m} minute${m === 1 ? "" : "s"}`;
}
