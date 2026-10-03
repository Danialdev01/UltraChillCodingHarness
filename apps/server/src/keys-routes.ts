import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { KEY_NAME_MAX, KEY_TAG_MAX, KEY_TAGS_MAX, KEY_URL_MAX, KEY_VALUE_MAX } from "@ucch/protocol";
import type { ProjectKeyService } from "./keys.js";
import type { ProjectSummary } from "./workspaces.js";

type ProjectRequest = { cookies: Record<string, string | undefined>; params: { hash: string } };

export interface KeyRouteDeps {
  /** The caller's project for `:hash`, or null -- the same gate every project route uses. */
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  /** Null when `SECRET_KEY` is not configured: nothing can be stored safely. */
  keys: ProjectKeyService | null;
}

const NO_SECRET_KEY = "SECRET_KEY is not configured, so a key cannot be stored safely";

const KeyId = z.string().uuid();

const Name = z.string().trim().min(1).max(KEY_NAME_MAX);
// Not trimmed: a value is stored exactly as pasted, minus nothing.
const Value = z.string().min(1).max(KEY_VALUE_MAX);
const Tags = z
  .array(z.string().trim().min(1).max(KEY_TAG_MAX))
  .max(KEY_TAGS_MAX)
  .transform((tags) => [...new Set(tags)]);
const Url = z
  .string()
  .trim()
  .max(KEY_URL_MAX)
  .refine((v) => v === "" || /^https?:\/\//i.test(v), { message: "must start with http:// or https://" })
  .nullable();

const KeyCreate = z.object({ name: Name, value: Value, tags: Tags.optional(), url: Url.optional() });

const KeyPatch = z
  .object({ name: Name.optional(), value: Value.optional(), tags: Tags.optional(), url: Url.optional() })
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "nothing to change" });

/**
 * A project's saved keys, under `/api/projects/:hash/keys`.
 *
 * Lists never carry a value. `GET .../keys/:keyId/value` is the one place a
 * value leaves the server, one key at a time, when someone asks to see or
 * copy it.
 */
export function registerKeyRoutes(app: FastifyInstance, deps: KeyRouteDeps): void {
  const { projectFor, keys } = deps;

  type Hash = { hash: string };
  type HashAndKey = { hash: string; keyId: string };

  const notFound = { error: "project not found" };
  const noKey = { error: "key not found" };

  app.get<{ Params: Hash }>("/api/projects/:hash/keys", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!keys) return { keys: [] };
    return { keys: await keys.list(project.id) };
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/keys", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!keys) return reply.code(409).send({ error: NO_SECRET_KEY });
    const parsed = KeyCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });
    return reply.code(201).send({ key: await keys.create(project.id, parsed.data) });
  });

  app.patch<{ Params: HashAndKey }>("/api/projects/:hash/keys/:keyId", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!keys) return reply.code(409).send({ error: NO_SECRET_KEY });
    if (!KeyId.safeParse(request.params.keyId).success) return reply.code(404).send(noKey);
    const parsed = KeyPatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });
    const key = await keys.update(project.id, request.params.keyId, parsed.data);
    if (!key) return reply.code(404).send(noKey);
    return { key };
  });

  app.delete<{ Params: HashAndKey }>("/api/projects/:hash/keys/:keyId", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!keys) return reply.code(404).send(noKey);
    if (!KeyId.safeParse(request.params.keyId).success) return reply.code(404).send(noKey);
    if (!(await keys.remove(project.id, request.params.keyId))) return reply.code(404).send(noKey);
    return reply.code(204).send();
  });

  app.get<{ Params: HashAndKey }>("/api/projects/:hash/keys/:keyId/value", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!keys) return reply.code(409).send({ error: NO_SECRET_KEY });
    if (!KeyId.safeParse(request.params.keyId).success) return reply.code(404).send(noKey);
    let value: string | null;
    try {
      value = await keys.reveal(project.id, request.params.keyId);
    } catch {
      // Encrypted under a SECRET_KEY that has since changed.
      return reply.code(409).send({ error: "the stored value cannot be read; SECRET_KEY has changed since it was saved" });
    }
    if (value === null) return reply.code(404).send(noKey);
    // A secret: never let a browser or proxy keep a copy.
    reply.header("cache-control", "no-store");
    return { value };
  });
}

/** The first thing wrong with the body, in the words of the field it is about. */
function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid request";
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
