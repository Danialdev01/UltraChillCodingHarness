import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  KEY_NAME_MAX,
  KEY_TAG_MAX,
  KEY_TAGS_MAX,
  KEY_URL_MAX,
  KEY_VALUE_MAX,
  PROJECT_KEY_MAX,
  PROJECT_KEY_MIN,
} from "@ucch/protocol";
import { UnreadableVault, WrongProjectKey } from "./env-vault.js";
import { AlreadyConfigured, NotConfigured, NotReady, TooManyVars, type EnvVarService } from "./env-vars.js";
import { SlidingWindow } from "./step-up.js";
import type { ProjectSummary } from "./workspaces.js";

type ProjectRequest = { cookies: Record<string, string | undefined>; params: { hash: string } };

export interface EnvRouteDeps {
  /** The caller's project for `:hash`, or null -- the same gate every project route uses. */
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  /** Who is asking, for the wrong-key limit; null falls back to the project alone. */
  userFor(request: ProjectRequest): Promise<string | null>;
  env: EnvVarService;
  now?: () => number;
}

/** Wrong project keys allowed per person and project in any `windowMs`. */
export const WRONG_KEY_LIMIT = { max: 10, windowMs: 5 * 60_000 };

const VarId = z.string().uuid();
const Name = z.string().trim().min(1).max(KEY_NAME_MAX);
// Not trimmed: a value is stored exactly as pasted.
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
/** Not trimmed either: a space is as much a part of a key as any other character. */
const ProjectKey = z.string().min(PROJECT_KEY_MIN, `must be at least ${PROJECT_KEY_MIN} characters`).max(PROJECT_KEY_MAX);
/** A key being checked rather than chosen: any length, so a short wrong one is a 403, not a 400. */
const GivenKey = z.string().min(1).max(PROJECT_KEY_MAX);

const Setup = z.object({ projectKey: ProjectKey });
const Change = z.object({ oldKey: GivenKey, newKey: ProjectKey });
const Unlock = z.object({ projectKey: GivenKey });
const VarCreate = z.object({ projectKey: GivenKey, name: Name, value: Value, tags: Tags.optional(), url: Url.optional() });
const VarPatch = z
  .object({ projectKey: GivenKey, name: Name.optional(), value: Value.optional(), tags: Tags.optional(), url: Url.optional() })
  .refine(({ projectKey: _k, ...p }) => Object.values(p).some((v) => v !== undefined), { message: "nothing to change" });

/**
 * A project's environment variables and its project key, under
 * `/api/projects/:hash/env`.
 *
 * The project key travels in the JSON body of each request that needs it
 * (`projectKey`, or `oldKey`/`newKey`), never in a URL or a header a proxy
 * might log, and is never stored. Lists never carry a value; `POST
 * .../vars/:varId/reveal` is the one place a value leaves the server.
 */
export function registerEnvRoutes(app: FastifyInstance, deps: EnvRouteDeps): void {
  const { projectFor, env } = deps;
  const wrongKeys = new SlidingWindow(WRONG_KEY_LIMIT.max, WRONG_KEY_LIMIT.windowMs, deps.now);

  type Hash = { hash: string };
  type HashAndVar = { hash: string; varId: string };
  const notFound = { error: "project not found" };
  const noVar = { error: "environment variable not found" };

  /** The limiter's key for this caller and project. */
  const limitKey = async (request: ProjectRequest, project: ProjectSummary) =>
    `${(await deps.userFor(request)) ?? "-"}:${project.id}`;

  /**
   * Runs `work`, turning the service's errors into answers. A wrong key
   * counts against the caller; past the limit, nothing is even tried.
   */
  async function guarded<T>(
    request: ProjectRequest,
    reply: FastifyReply,
    project: ProjectSummary,
    work: () => Promise<T>,
  ): Promise<T | FastifyReply> {
    const limit = await limitKey(request, project);
    const wait = wrongKeys.retryAfter(limit);
    if (wait > 0) {
      reply.header("retry-after", String(wait));
      return reply.code(429).send({ error: `Too many wrong project keys. Try again in ${wait} seconds.`, retryAfterSeconds: wait });
    }
    try {
      return await work();
    } catch (error) {
      if (error instanceof WrongProjectKey) {
        wrongKeys.hit(limit);
        return reply.code(403).send({ error: "wrong project key", code: "wrong_project_key" });
      }
      if (error instanceof NotConfigured) return reply.code(409).send({ error: error.message, code: "not_configured" });
      if (error instanceof AlreadyConfigured) return reply.code(409).send({ error: error.message, code: "already_configured" });
      if (error instanceof NotReady) return reply.code(409).send({ error: error.message, code: "not_ready" });
      if (error instanceof TooManyVars) return reply.code(409).send({ error: error.message });
      if (error instanceof UnreadableVault) return reply.code(409).send({ error: error.message, code: "unreadable" });
      throw error;
    }
  }

  const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): z.infer<S> | null => {
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    void reply.code(400).send({ error: describe(parsed.error) });
    return null;
  };

  app.get<{ Params: Hash }>("/api/projects/:hash/env", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    return guarded(request, reply, project, () => env.list(project.id));
  });

  app.get<{ Params: Hash }>("/api/projects/:hash/env/project-key", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    return guarded(request, reply, project, () => env.status(project.id));
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/env/project-key", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const body = parse(Setup, request.body, reply);
    if (!body) return reply;
    return guarded(request, reply, project, async () =>
      reply.code(201).send(await env.setup(project.id, body.projectKey)),
    );
  });

  app.put<{ Params: Hash }>("/api/projects/:hash/env/project-key", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const body = parse(Change, request.body, reply);
    if (!body) return reply;
    return guarded(request, reply, project, async () => {
      await env.changeKey(project.id, body.oldKey, body.newKey);
      return reply.code(204).send();
    });
  });

  app.delete<{ Params: Hash }>("/api/projects/:hash/env/project-key", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    return guarded(request, reply, project, async () => {
      await env.reset(project.id);
      return reply.code(204).send();
    });
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/env/unlock", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const body = parse(Unlock, request.body, reply);
    if (!body) return reply;
    return guarded(request, reply, project, async () => {
      await env.unlock(project.id, body.projectKey);
      wrongKeys.clear(await limitKey(request, project));
      return reply.code(204).send();
    });
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/env/vars", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const body = parse(VarCreate, request.body, reply);
    if (!body) return reply;
    const { projectKey, ...input } = body;
    return guarded(request, reply, project, async () =>
      reply.code(201).send({ var: await env.create(project.id, projectKey, input) }),
    );
  });

  app.patch<{ Params: HashAndVar }>("/api/projects/:hash/env/vars/:varId", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!VarId.safeParse(request.params.varId).success) return reply.code(404).send(noVar);
    const body = parse(VarPatch, request.body, reply);
    if (!body) return reply;
    const { projectKey, ...patch } = body;
    return guarded(request, reply, project, async () => {
      const updated = await env.update(project.id, projectKey, request.params.varId, patch);
      return updated ? { var: updated } : reply.code(404).send(noVar);
    });
  });

  app.delete<{ Params: HashAndVar }>("/api/projects/:hash/env/vars/:varId", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!VarId.safeParse(request.params.varId).success) return reply.code(404).send(noVar);
    const body = parse(Unlock, request.body, reply);
    if (!body) return reply;
    return guarded(request, reply, project, async () =>
      (await env.remove(project.id, body.projectKey, request.params.varId))
        ? reply.code(204).send()
        : reply.code(404).send(noVar),
    );
  });

  app.post<{ Params: HashAndVar }>("/api/projects/:hash/env/vars/:varId/reveal", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!VarId.safeParse(request.params.varId).success) return reply.code(404).send(noVar);
    const body = parse(Unlock, request.body, reply);
    if (!body) return reply;
    return guarded(request, reply, project, async () => {
      const value = await env.reveal(project.id, body.projectKey, request.params.varId);
      if (value === null) return reply.code(404).send(noVar);
      // A secret: never let a browser or proxy keep a copy.
      reply.header("cache-control", "no-store");
      return { value };
    });
  });
}

/** The first thing wrong with the body, in the words of the field it is about. */
function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid request";
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
