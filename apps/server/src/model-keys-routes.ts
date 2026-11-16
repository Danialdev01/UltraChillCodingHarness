import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DuplicateNameError,
  KIND_NAMES,
  MODEL_KEY_KINDS,
  checkModelKeyFormat,
  type ModelKeyCheck,
  type ModelKeyKind,
  type ModelKeyStore,
} from "./model-keys.js";

/**
 * The named model keys, listed under Settings -> Providers -> Custom.
 *
 *   GET    /api/account/model-keys        metadata only, never a value
 *   POST   /api/account/model-keys        { kind, name, key }: format check, live check, store
 *   PATCH  /api/account/model-keys/:id    { name }
 *   POST   /api/account/model-keys/:id/default   makes an OpenRouter key the account's default
 *   DELETE /api/account/model-keys/:id
 *
 * A named key never leaves the server: there is no reveal. Replacing one is
 * removing it and adding another.
 */

export interface ModelKeyAuditEntry {
  userId: string;
  action: "model_key.created" | "model_key.renamed" | "model_key.removed" | "model_key.default_set";
  keyId: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface ModelKeyRouteDeps {
  principal(request: FastifyRequest): Promise<{ userId: string } | null>;
  keys: ModelKeyStore;
  encryptionAvailable: boolean;
  check(kind: ModelKeyKind, key: string): Promise<ModelKeyCheck>;
  audit(entry: ModelKeyAuditEntry): Promise<void>;
}

/** Room for "Work OpenRouter (team budget)", and short enough to sit in a picker. */
export const MAX_NAME_LENGTH = 40;
/** How many named keys one account may keep. */
export const MAX_MODEL_KEYS = 20;

const Name = z
  .string()
  .trim()
  .min(1, "Give the key a name.")
  .max(MAX_NAME_LENGTH, `Keep the name to ${MAX_NAME_LENGTH} characters.`);
const CreateBody = z.object({ kind: z.enum(MODEL_KEY_KINDS), name: Name, key: z.string().max(400) });
const RenameBody = z.object({ name: Name });
const Id = z.string().uuid();

const NO_SECRET_KEY = "SECRET_KEY is not configured on the server, so keys cannot be stored.";

export function registerModelKeyRoutes(app: FastifyInstance, deps: ModelKeyRouteDeps): void {
  const who = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: String(request.headers["user-agent"] ?? "").slice(0, 300) || null,
  });

  app.get("/api/account/model-keys", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    return { keys: await deps.keys.list(principal.userId), encryptionAvailable: deps.encryptionAvailable };
  });

  app.post("/api/account/model-keys", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    if (!deps.encryptionAvailable) return reply.code(409).send({ error: NO_SECRET_KEY });
    const parsed = CreateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid key." });
    const { kind, name } = parsed.data;
    const key = parsed.data.key.trim();
    if (!key) return reply.code(400).send({ error: "Paste a key." });
    const formatError = checkModelKeyFormat(kind, key);
    if (formatError) return reply.code(400).send({ error: formatError });

    const existing = await deps.keys.list(principal.userId);
    if (existing.length >= MAX_MODEL_KEYS) {
      return reply.code(409).send({ error: `You can keep up to ${MAX_MODEL_KEYS} named keys. Remove one first.` });
    }
    if (existing.some((k) => k.name.toLowerCase() === name.toLowerCase())) {
      return reply.code(409).send({ error: new DuplicateNameError(name).message });
    }

    const check = await deps.check(kind, key);
    if (!check.ok) return reply.code(422).send({ error: check.error });

    try {
      const meta = await deps.keys.create(principal.userId, kind, name, key);
      await deps.audit({
        userId: principal.userId,
        action: "model_key.created",
        keyId: meta.id,
        summary: `Added the ${KIND_NAMES[kind]} key "${name}"`,
        details: { kind, name, ...who(request) },
      });
      return { key: meta };
    } catch (error) {
      if (error instanceof DuplicateNameError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/api/account/model-keys/:id", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    if (!Id.safeParse(request.params.id).success) return reply.code(404).send({ error: "No such key." });
    const parsed = RenameBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid name." });
    try {
      const meta = await deps.keys.rename(principal.userId, request.params.id, parsed.data.name);
      if (!meta) return reply.code(404).send({ error: "No such key." });
      await deps.audit({
        userId: principal.userId,
        action: "model_key.renamed",
        keyId: meta.id,
        summary: `Renamed a ${KIND_NAMES[meta.kind]} key to "${meta.name}"`,
        details: { kind: meta.kind, name: meta.name, ...who(request) },
      });
      return { key: meta };
    } catch (error) {
      if (error instanceof DuplicateNameError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  // The OpenRouter key voice input, research, OMP and the other general
  // uses bill. One per account; choosing another unmarks the last.
  app.post<{ Params: { id: string } }>("/api/account/model-keys/:id/default", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    if (!Id.safeParse(request.params.id).success) return reply.code(404).send({ error: "No such key." });
    const meta = await deps.keys.setDefault(principal.userId, request.params.id);
    if (!meta) return reply.code(404).send({ error: "No such OpenRouter key." });
    await deps.audit({
      userId: principal.userId,
      action: "model_key.default_set",
      keyId: meta.id,
      summary: `Made the OpenRouter key "${meta.name}" the default`,
      details: { kind: meta.kind, name: meta.name, ...who(request) },
    });
    return { key: meta };
  });

  app.delete<{ Params: { id: string } }>("/api/account/model-keys/:id", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    if (!Id.safeParse(request.params.id).success) return reply.code(404).send({ error: "No such key." });
    const before = (await deps.keys.list(principal.userId)).find((k) => k.id === request.params.id);
    const removed = await deps.keys.remove(principal.userId, request.params.id);
    if (!removed || !before) return reply.code(404).send({ error: "No such key." });
    await deps.audit({
      userId: principal.userId,
      action: "model_key.removed",
      keyId: before.id,
      summary: `Removed the ${KIND_NAMES[before.kind]} key "${before.name}"`,
      details: { kind: before.kind, name: before.name, ...who(request) },
    });
    return { ok: true };
  });
}
