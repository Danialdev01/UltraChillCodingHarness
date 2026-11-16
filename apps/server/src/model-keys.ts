import { and, asc, eq, sql } from "drizzle-orm";
import { modelKeys, type Database } from "@ucch/db";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { keyLast4 } from "./account-keys.js";
import type { ModelChoice } from "./openrouter.js";

/**
 * Named model-provider keys: any number per account, each of a kind
 * (OpenRouter, AnonRouter), each with a name of its owner's choosing.
 *
 * One OpenRouter key among them is the account's default (`is_default`):
 * OMP, research, transcription and the other general uses bill it, through
 * `accountOpenRouterKey`, and the key stored on the account before named
 * keys only when there is no named OpenRouter key. A named key is chosen in the composer: a
 * model picked under it travels as `@<keyId>/<model>` (see `parseKeyedModel`),
 * and the native turn resolves the key, the provider's base URL and the bare
 * model id from that.
 */

export const MODEL_KEY_KINDS = ["openrouter", "anonrouter"] as const;
export type ModelKeyKind = (typeof MODEL_KEY_KINDS)[number];

export function isModelKeyKind(value: string): value is ModelKeyKind {
  return (MODEL_KEY_KINDS as readonly string[]).includes(value);
}

export const KIND_NAMES: Record<ModelKeyKind, string> = {
  openrouter: "OpenRouter",
  anonrouter: "AnonRouter",
};

/** OpenRouter's follows `OPENROUTER_BASE_URL`; set once at boot. */
const BASE_URLS: Record<ModelKeyKind, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  anonrouter: "https://api.anonrouter.ai/v1",
};

export function setModelKeyBase(kind: ModelKeyKind, url: string): void {
  BASE_URLS[kind] = url.replace(/\/+$/, "");
}

export function baseUrlFor(kind: ModelKeyKind): string {
  return BASE_URLS[kind];
}

const PREFIXES: Record<ModelKeyKind, RegExp> = {
  openrouter: /^sk-or-(?:v\d+-)?/,
  anonrouter: /^ar_/,
};

export function modelKeyPrefix(kind: ModelKeyKind, key: string): string {
  return PREFIXES[kind].exec(key)?.[0] ?? "";
}

/** Why a pasted key cannot be one of this kind's, or null when it could. A shape check only. */
export function checkModelKeyFormat(kind: ModelKeyKind, key: string): string | null {
  if (/\s/.test(key)) return "The key contains spaces or line breaks. Paste it again without them.";
  switch (kind) {
    case "openrouter":
      return /^sk-or-[A-Za-z0-9_-]{20,}$/.test(key)
        ? null
        : "That doesn't look like an OpenRouter key. They start with sk-or-v1-.";
    case "anonrouter":
      // `arm_` is a management key: it reads the balance but cannot run a model.
      if (key.startsWith("arm_")) {
        return "That is an AnonRouter management key (arm_). Create an inference key (ar_) with OpenAI-compatible access.";
      }
      return /^ar_[A-Za-z0-9_-]{8,}$/.test(key) ? null : "That doesn't look like an AnonRouter key. They start with ar_.";
  }
}

export type ModelKeyCheck = { ok: true } | { ok: false; error: string };
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Asks the provider whether the key works, before it is stored. Only the
 * status is read: an error body could echo the key back.
 */
export async function checkModelKeyLive(kind: ModelKeyKind, key: string, fetchImpl: Fetch = fetch): Promise<ModelKeyCheck> {
  const name = KIND_NAMES[kind];
  // OpenRouter's key endpoint, and AnonRouter's model list, which needs an
  // authenticated inference key.
  const url = kind === "openrouter" ? `${BASE_URLS.openrouter}/key` : `${BASE_URLS.anonrouter}/models`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, error: `Couldn't reach ${name} to check the key. Nothing was saved; try again in a moment.` };
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
  return { ok: true };
}

/** A model id that names a key: `@<uuid>/<model>`. */
const KEYED = /^@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/i;

export function parseKeyedModel(model: string): { keyId: string; model: string } | null {
  const match = KEYED.exec(model);
  return match ? { keyId: match[1]!.toLowerCase(), model: match[2]! } : null;
}

export function keyedModel(keyId: string, model: string): string {
  return `@${keyId}/${model}`;
}

export interface ModelKeyMeta {
  id: string;
  kind: ModelKeyKind;
  name: string;
  prefix: string;
  last4: string;
  /** The account's OpenRouter key for voice input, research, OMP and the rest. OpenRouter keys only. */
  isDefault: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What the routes and the agent need from storage. */
export interface ModelKeyStore {
  list(userId: string): Promise<ModelKeyMeta[]>;
  create(userId: string, kind: ModelKeyKind, name: string, key: string): Promise<ModelKeyMeta>;
  rename(userId: string, id: string, name: string): Promise<ModelKeyMeta | null>;
  remove(userId: string, id: string): Promise<boolean>;
  /** Makes an OpenRouter key the account's default; null when it is not this user's OpenRouter key. */
  setDefault(userId: string, id: string): Promise<ModelKeyMeta | null>;
  /** The key in the clear, its kind, and its use recorded; null when it is not this user's. */
  use(userId: string, id: string): Promise<{ kind: ModelKeyKind; key: string; name: string } | null>;
}

/** A second key with a name the account already uses. */
export class DuplicateNameError extends Error {
  constructor(name: string) {
    super(`You already have a key called "${name}". Pick another name.`);
  }
}

function toMeta(row: typeof modelKeys.$inferSelect): ModelKeyMeta {
  return {
    id: row.id,
    kind: isModelKeyKind(row.kind) ? row.kind : "openrouter",
    name: row.name,
    prefix: row.prefix,
    last4: row.last4,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export class DbModelKeys implements ModelKeyStore {
  constructor(
    private readonly db: Database,
    private readonly secretKey: string,
  ) {}

  async list(userId: string): Promise<ModelKeyMeta[]> {
    const rows = await this.db
      .select()
      .from(modelKeys)
      .where(eq(modelKeys.userId, userId))
      .orderBy(asc(modelKeys.createdAt));
    return rows.map(toMeta);
  }

  async create(userId: string, kind: ModelKeyKind, name: string, key: string): Promise<ModelKeyMeta> {
    // The account's first OpenRouter key is its default; later ones wait to be chosen.
    const first =
      kind === "openrouter" &&
      (await this.db
        .select({ id: modelKeys.id })
        .from(modelKeys)
        .where(and(eq(modelKeys.userId, userId), eq(modelKeys.kind, "openrouter")))
        .limit(1)).length === 0;
    try {
      const [row] = await this.db
        .insert(modelKeys)
        .values({
          userId,
          kind,
          name,
          isDefault: first,
          keyEncrypted: encryptSecret(key, this.secretKey),
          prefix: modelKeyPrefix(kind, key),
          last4: keyLast4(key),
        })
        .returning();
      return toMeta(row!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateNameError(name);
      throw error;
    }
  }

  async rename(userId: string, id: string, name: string): Promise<ModelKeyMeta | null> {
    try {
      const [row] = await this.db
        .update(modelKeys)
        .set({ name, updatedAt: new Date() })
        .where(and(eq(modelKeys.id, id), eq(modelKeys.userId, userId)))
        .returning();
      return row ? toMeta(row) : null;
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateNameError(name);
      throw error;
    }
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const removed = await this.db
      .delete(modelKeys)
      .where(and(eq(modelKeys.id, id), eq(modelKeys.userId, userId)))
      .returning({ id: modelKeys.id, isDefault: modelKeys.isDefault });
    if (removed[0]?.isDefault) {
      // The default went: the oldest OpenRouter key left takes over, so
      // there is one whenever there is any.
      const [next] = await this.db
        .select({ id: modelKeys.id })
        .from(modelKeys)
        .where(and(eq(modelKeys.userId, userId), eq(modelKeys.kind, "openrouter")))
        .orderBy(asc(modelKeys.createdAt))
        .limit(1);
      if (next) await this.db.update(modelKeys).set({ isDefault: true }).where(eq(modelKeys.id, next.id));
    }
    return removed.length > 0;
  }

  async setDefault(userId: string, id: string): Promise<ModelKeyMeta | null> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx
        .select({ id: modelKeys.id })
        .from(modelKeys)
        .where(and(eq(modelKeys.id, id), eq(modelKeys.userId, userId), eq(modelKeys.kind, "openrouter")))
        .limit(1);
      if (!target) return null;
      await tx
        .update(modelKeys)
        .set({ isDefault: false })
        .where(and(eq(modelKeys.userId, userId), eq(modelKeys.isDefault, true)));
      const [row] = await tx
        .update(modelKeys)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(modelKeys.id, id))
        .returning();
      return row ? toMeta(row) : null;
    });
  }

  async use(userId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(modelKeys)
      .where(and(eq(modelKeys.id, id), eq(modelKeys.userId, userId)))
      .limit(1);
    if (!row || !isModelKeyKind(row.kind)) return null;
    const key = decryptSecret(row.keyEncrypted, this.secretKey);
    // Bookkeeping: a failed write never fails the turn.
    void this.db
      .update(modelKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(modelKeys.id, id))
      .catch(() => {});
    return { kind: row.kind, key, name: row.name };
  }
}

/**
 * AnonRouter's catalogue: public, so the picker can list it before anything
 * is called with the key. Only what the agent loop can run -- callable text
 * models -- and not the end-to-end-encrypted routes, which need the client
 * to encrypt every prompt to an attested enclave.
 */
const ANONROUTER_CATALOG_URL = "https://control.anonrouter.ai/v1/catalog/models";

interface AnonCatalogModel {
  id?: unknown;
  displayName?: unknown;
  callable?: unknown;
  primaryModality?: unknown;
  privacyLevel?: unknown;
  availability?: unknown;
  contextTokens?: unknown;
  features?: unknown;
  /** "uncensored" for models tuned to refuse less; "unknown" for the rest. */
  moderation?: unknown;
}

export function mapAnonCatalog(body: unknown): ModelChoice[] {
  const models = (body as { models?: AnonCatalogModel[] } | null)?.models ?? [];
  const seen = new Set<string>();
  const out: ModelChoice[] = [];
  for (const m of models) {
    if (typeof m.id !== "string" || seen.has(m.id)) continue;
    if (m.callable !== true || m.primaryModality !== "text" || m.privacyLevel === "e2ee") continue;
    if (m.availability === "deprecated") continue;
    seen.add(m.id);
    const features = Array.isArray(m.features) ? (m.features as unknown[]) : [];
    out.push({
      id: m.id,
      name: typeof m.displayName === "string" && m.displayName ? m.displayName : m.id,
      provider: m.id.split("/")[0] ?? "other",
      contextLength: typeof m.contextTokens === "number" ? m.contextTokens : null,
      reasoning: features.includes("reasoning"),
      images: features.includes("vision"),
      ...(m.moderation === "uncensored" ? { uncensored: true } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

let anonCache: { at: number; models: ModelChoice[] } | null = null;
const ANON_TTL_MS = 30 * 60_000;

/** Cached like OpenRouter's; a failed refresh serves the last good list. */
export async function anonCatalogue(fetchImpl: Fetch = fetch): Promise<ModelChoice[]> {
  if (anonCache && Date.now() - anonCache.at < ANON_TTL_MS) return anonCache.models;
  try {
    const response = await fetchImpl(ANONROUTER_CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`anonrouter catalogue failed: ${response.status}`);
    const models = mapAnonCatalog(await response.json());
    anonCache = { at: Date.now(), models };
    return models;
  } catch (error) {
    if (anonCache) return anonCache.models;
    throw error;
  }
}

/**
 * The account's OpenRouter key, encrypted, as a column expression on
 * `users`: the default named OpenRouter key (the oldest, should none be
 * marked), else the key stored on the account itself before named keys.
 * Everything that bills "your OpenRouter key" rather than a key a turn
 * named -- voice input, research, OMP, the quota card -- reads this.
 */
//
// Spelled out with table names: Drizzle leaves columns unqualified inside a
// `sql` fragment in a one-table select, and an unqualified "id" in the
// subquery is `model_keys.id`, which never equals the user's -- every
// lookup came back without a key.
export const accountOpenRouterKey = sql<string | null>`coalesce((
  select mk."key_encrypted" from "model_keys" mk
  where mk."user_id" = "users"."id" and mk."kind" = 'openrouter'
  order by mk."is_default" desc, mk."created_at" asc
  limit 1
), "users"."openrouter_key_encrypted")`;
