import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ResourceFolderCreate,
  ResourceMove,
  S3StoreCreate,
  S3StoreUpdate,
  mediaTypeFor,
  type WorkspacePermission,
} from "@ucch/protocol";
import {
  ResourceConflictError,
  ResourceKeyError,
  ResourceStoreError,
  keyOf,
  resourceName,
  type ResourceBackend,
  type ResourceStoreService,
} from "./resource-stores.js";
import { contentDisposition } from "./uploads.js";

type Principal = { userId: string };

export interface ResourceRouteDeps {
  principalFor(cookies: Record<string, string | undefined>): Promise<Principal | null>;
  workspaceAllows(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<boolean>;
  stores: ResourceStoreService;
  /** `SECRET_KEY`; without it no S3 secret can be stored, so no S3 store can be. */
  secretKey: string | undefined;
  /** The largest file one upload may carry. */
  maxUploadBytes: number;
}

const NO_SECRET_KEY = "SECRET_KEY is not configured, so an S3 secret cannot be stored safely";

/** Turns the store's own refusals into status codes; anything else is a server error. */
export function resourceFailure(error: unknown, reply: FastifyReply) {
  if (error instanceof ResourceKeyError) return reply.code(400).send({ error: error.message });
  if (error instanceof ResourceConflictError) return reply.code(409).send({ error: error.message });
  if (error instanceof ResourceStoreError) return reply.code(502).send({ error: `The store refused: ${error.message}` });
  throw error;
}

function badBody(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return { error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body" };
}

/**
 * The workspace's Resources: its stores, and the files in each.
 *
 * Reading is for anyone who can see the workspace; changing files needs
 * `project.write` (a viewer reads only); adding, changing or forgetting an S3
 * store needs `credentials.manage`, since it is a stored secret. A workspace
 * the caller cannot see is a 404 throughout, never a 403 that confirms it.
 */
export function registerResourceRoutes(app: FastifyInstance, deps: ResourceRouteDeps): void {
  /** The caller, when they hold `permission` in the workspace; else the reply is sent. */
  async function allowed(
    request: { cookies: Record<string, string | undefined> },
    reply: FastifyReply,
    workspaceId: string,
    permission: WorkspacePermission,
  ): Promise<Principal | null> {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (!(await deps.workspaceAllows(workspaceId, principal.userId, "workspace.view"))) {
      void reply.code(404).send({ error: "workspace not found" });
      return null;
    }
    if (permission !== "workspace.view" && !(await deps.workspaceAllows(workspaceId, principal.userId, permission))) {
      void reply.code(403).send({ error: "your role in this workspace cannot do that" });
      return null;
    }
    return principal;
  }

  async function backendOr404(
    reply: FastifyReply,
    workspaceId: string,
    storeId: string,
  ): Promise<ResourceBackend | null> {
    const backend = await deps.stores.backend(workspaceId, storeId);
    if (!backend) void reply.code(404).send({ error: "store not found" });
    return backend;
  }

  // ---- Stores ----------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/resource-stores", async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
    return { stores: await deps.stores.list(request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/workspaces/:id/resource-stores", async (request, reply) => {
    const principal = await allowed(request, reply, request.params.id, "credentials.manage");
    if (!principal) return reply;
    const parsed = S3StoreCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    if (!deps.secretKey) return reply.code(409).send({ error: NO_SECRET_KEY });
    try {
      const store = await deps.stores.create(request.params.id, principal.userId, parsed.data, deps.secretKey);
      return reply.code(201).send({ store });
    } catch (error) {
      if (error instanceof ResourceStoreError) {
        return reply.code(422).send({ error: `Could not reach the bucket: ${error.message}` });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string; storeId: string } }>(
    "/api/workspaces/:id/resource-stores/:storeId",
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "credentials.manage"))) return reply;
      const parsed = S3StoreUpdate.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
      if (!deps.secretKey) return reply.code(409).send({ error: NO_SECRET_KEY });
      try {
        const store = await deps.stores.update(request.params.id, request.params.storeId, parsed.data, deps.secretKey);
        if (!store) return reply.code(404).send({ error: "store not found" });
        return { store };
      } catch (error) {
        if (error instanceof ResourceStoreError) {
          return reply.code(422).send({ error: `Could not reach the bucket: ${error.message}` });
        }
        throw error;
      }
    },
  );

  app.delete<{ Params: { id: string; storeId: string } }>(
    "/api/workspaces/:id/resource-stores/:storeId",
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "credentials.manage"))) return reply;
      const removed = await deps.stores.remove(request.params.id, request.params.storeId);
      if (!removed) return reply.code(404).send({ error: "store not found" });
      return reply.code(204).send();
    },
  );

  // ---- Files -----------------------------------------------------------------

  app.get<{ Params: { id: string; storeId: string }; Querystring: { prefix?: string } }>(
    "/api/workspaces/:id/resources/:storeId",
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
      const backend = await backendOr404(reply, request.params.id, request.params.storeId);
      if (!backend) return reply;
      try {
        return { entries: await backend.list(keyOf(request.query.prefix ?? "", true)) };
      } catch (error) {
        return resourceFailure(error, reply);
      }
    },
  );

  /**
   * A file's bytes, inline for a preview or as a download. The same rules as
   * a staged upload's `/content`: the type comes from the name's extension
   * allow-list, never from the store, and the response is sandboxed so an
   * SVG or an HTML file cannot run anything on this origin.
   */
  app.get<{ Params: { id: string; storeId: string }; Querystring: { key?: string; download?: string } }>(
    "/api/workspaces/:id/resources/:storeId/content",
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
      const backend = await backendOr404(reply, request.params.id, request.params.storeId);
      if (!backend) return reply;
      try {
        const key = keyOf(request.query.key ?? "");
        const download = request.query.download === "1";
        const mediaType = mediaTypeFor(key);
        if (!download && !mediaType) return reply.code(415).send({ error: "this file cannot be previewed" });
        const file = await backend.read(key);
        if (!file) return reply.code(404).send({ error: "file not found" });
        return reply
          .header("content-type", download ? "application/octet-stream" : mediaType!)
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
          .header("content-disposition", download ? contentDisposition(resourceName(key)) : "inline")
          .header("cache-control", "private, no-store")
          .header("content-length", file.size)
          .send(file.stream);
      } catch (error) {
        return resourceFailure(error, reply);
      }
    },
  );

  /** An upload: the raw bytes as `application/octet-stream`, the key in the query. */
  app.post<{ Params: { id: string; storeId: string }; Querystring: { key?: string; type?: string; overwrite?: string } }>(
    "/api/workspaces/:id/resources/:storeId",
    { bodyLimit: deps.maxUploadBytes },
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: "send the file as application/octet-stream" });
      }
      const backend = await backendOr404(reply, request.params.id, request.params.storeId);
      if (!backend) return reply;
      try {
        const key = keyOf(request.query.key ?? "");
        await backend.write(
          key,
          request.body,
          request.query.type || "application/octet-stream",
          request.query.overwrite === "1",
        );
        return reply.code(201).send({ key });
      } catch (error) {
        return resourceFailure(error, reply);
      }
    },
  );

  app.post<{ Params: { id: string; storeId: string } }>(
    "/api/workspaces/:id/resources/:storeId/folder",
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
      const parsed = ResourceFolderCreate.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
      const backend = await backendOr404(reply, request.params.id, request.params.storeId);
      if (!backend) return reply;
      try {
        const key = keyOf(parsed.data.key);
        await backend.mkdir(key);
        return reply.code(201).send({ key });
      } catch (error) {
        return resourceFailure(error, reply);
      }
    },
  );

  app.patch<{ Params: { id: string; storeId: string } }>(
    "/api/workspaces/:id/resources/:storeId/move",
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
      const parsed = ResourceMove.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
      const backend = await backendOr404(reply, request.params.id, request.params.storeId);
      if (!backend) return reply;
      try {
        const from = keyOf(parsed.data.from);
        const to = keyOf(parsed.data.to);
        await backend.move(from, to);
        return { key: to };
      } catch (error) {
        return resourceFailure(error, reply);
      }
    },
  );

  app.delete<{ Params: { id: string; storeId: string }; Querystring: { key?: string } }>(
    "/api/workspaces/:id/resources/:storeId",
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
      const backend = await backendOr404(reply, request.params.id, request.params.storeId);
      if (!backend) return reply;
      try {
        const removed = await backend.remove(keyOf(request.query.key ?? ""));
        if (!removed) return reply.code(404).send({ error: "file not found" });
        return reply.code(204).send();
      } catch (error) {
        return resourceFailure(error, reply);
      }
    },
  );
}
