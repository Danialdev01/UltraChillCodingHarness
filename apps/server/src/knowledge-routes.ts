import type { FastifyInstance, FastifyReply } from "fastify";
import { createReadStream } from "node:fs";
import {
  KNOWLEDGE_UPLOAD_CHUNK_BYTES,
  KnowledgeBaseCreate,
  KnowledgeBaseUpdate,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  type WorkspacePermission,
} from "@ucch/protocol";
import type { KnowledgeService, UploadRefusal } from "./knowledge.js";
import { contentDisposition } from "./uploads.js";

type Principal = { userId: string };

export interface KnowledgeRouteDeps {
  principalFor(cookies: Record<string, string | undefined>): Promise<Principal | null>;
  workspaceAllows(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<boolean>;
  knowledge: KnowledgeService;
  /** The largest document one upload may carry. */
  maxUploadBytes: number;
}

type UploadParams = { id: string; baseId: string; uploadId: string };

/** A refused chunk or finish, as a status and a sentence. */
function refusal(reply: FastifyReply, result: UploadRefusal) {
  switch (result.refused) {
    case "not_found":
      return reply.code(404).send({ error: "upload not found: it may have expired, so start it again" });
    case "offset":
      return reply.code(409).send({ error: "that chunk is not the next one", received: result.received });
    case "busy":
      return reply.code(409).send({ error: "a chunk of this upload is still being written" });
    case "too_big":
      return reply.code(413).send({ error: "more bytes than the upload said it would carry" });
    case "incomplete":
      return reply.code(409).send({ error: "the upload is not complete", received: result.received });
  }
}

function badBody(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  const issue = error.issues[0];
  return { error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body" };
}

/**
 * A workspace's knowledge bases, their documents and graphs.
 *
 * Reading is for anyone who can see the workspace; creating, uploading and
 * deleting needs `project.write`, as Resources does. A workspace the caller
 * cannot see is a 404 throughout, never a 403 that confirms it.
 */
export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRouteDeps): void {
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

  const k = deps.knowledge;
  const BASES = "/api/workspaces/:id/knowledge";
  const BASE = `${BASES}/:baseId`;
  type BaseParams = { Params: { id: string; baseId: string } };
  type DocParams = { Params: { id: string; baseId: string; docId: string } };

  app.get<{ Params: { id: string } }>(BASES, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
    return { bases: await k.list(request.params.id) };
  });

  app.post<{ Params: { id: string } }>(BASES, async (request, reply) => {
    const principal = await allowed(request, reply, request.params.id, "project.write");
    if (!principal) return reply;
    const parsed = KnowledgeBaseCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    return reply.code(201).send({ base: await k.create(request.params.id, principal.userId, parsed.data) });
  });

  app.get<BaseParams>(BASE, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
    const base = await k.get(request.params.id, request.params.baseId);
    if (!base) return reply.code(404).send({ error: "knowledge base not found" });
    return { base };
  });

  app.patch<BaseParams>(BASE, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
    const parsed = KnowledgeBaseUpdate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(badBody(parsed.error));
    const base = await k.update(request.params.id, request.params.baseId, parsed.data);
    if (!base) return reply.code(404).send({ error: "knowledge base not found" });
    return { base };
  });

  app.delete<BaseParams>(BASE, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
    if (!(await k.remove(request.params.id, request.params.baseId))) {
      return reply.code(404).send({ error: "knowledge base not found" });
    }
    return reply.code(204).send();
  });

  app.get<BaseParams>(`${BASE}/documents`, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
    const documents = await k.documents(request.params.id, request.params.baseId);
    if (!documents) return reply.code(404).send({ error: "knowledge base not found" });
    return { documents };
  });

  /** An upload: the raw bytes as `application/octet-stream`, the name and type in the query. */
  app.post<BaseParams & { Querystring: { name?: string; type?: string } }>(
    `${BASE}/documents`,
    { bodyLimit: deps.maxUploadBytes },
    async (request, reply) => {
      const principal = await allowed(request, reply, request.params.id, "project.write");
      if (!principal) return reply;
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: "send the file as application/octet-stream" });
      }
      if (request.body.length === 0) return reply.code(400).send({ error: "the file is empty" });
      const name = (request.query.name ?? "").trim();
      if (!name) return reply.code(400).send({ error: "name: required" });
      const document = await k.addDocument(request.params.id, request.params.baseId, principal.userId, {
        name,
        mediaType: request.query.type ?? "application/octet-stream",
        bytes: request.body,
      });
      if (!document) return reply.code(404).send({ error: "knowledge base not found" });
      return reply.code(201).send({ document });
    },
  );

  /**
   * A large document in pieces: start with its name, type and size, send
   * each `KNOWLEDGE_UPLOAD_CHUNK_BYTES` piece with its offset, then finish.
   * No single request is large, so nothing in front of the API buffers much.
   */
  app.post<BaseParams & { Body: { name?: unknown; type?: unknown; size?: unknown } }>(
    `${BASE}/uploads`,
    async (request, reply) => {
      const principal = await allowed(request, reply, request.params.id, "project.write");
      if (!principal) return reply;
      const body = request.body ?? {};
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const size = typeof body.size === "number" ? body.size : NaN;
      if (!name) return reply.code(400).send({ error: "name: required" });
      if (!Number.isSafeInteger(size) || size <= 0) return reply.code(400).send({ error: "size: a positive whole number of bytes" });
      if (size > MAX_KNOWLEDGE_DOCUMENT_BYTES) {
        return reply.code(413).send({ error: "That file is over 2.5 GB, the most one document can be." });
      }
      const started = await k.startUpload(request.params.id, request.params.baseId, principal.userId, {
        name,
        mediaType: typeof body.type === "string" && body.type ? body.type : "application/octet-stream",
        size,
      });
      if (!started) return reply.code(404).send({ error: "knowledge base not found" });
      return reply.code(201).send({ ...started, chunkBytes: KNOWLEDGE_UPLOAD_CHUNK_BYTES });
    },
  );

  app.put<{ Params: UploadParams; Querystring: { offset?: string } }>(
    `${BASE}/uploads/:uploadId`,
    // A chunk, with room for a sender that cuts its pieces a little larger.
    { bodyLimit: KNOWLEDGE_UPLOAD_CHUNK_BYTES * 2 },
    async (request, reply) => {
      if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: "send the chunk as application/octet-stream" });
      }
      const offset = Number(request.query.offset);
      if (!Number.isSafeInteger(offset) || offset < 0) return reply.code(400).send({ error: "offset: required" });
      const result = await k.appendUpload(request.params.id, request.params.baseId, request.params.uploadId, offset, request.body);
      return "refused" in result ? refusal(reply, result) : result;
    },
  );

  app.post<{ Params: UploadParams }>(`${BASE}/uploads/:uploadId/complete`, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
    const result = await k.finishUpload(request.params.id, request.params.baseId, request.params.uploadId);
    return "refused" in result ? refusal(reply, result) : reply.code(201).send({ document: result });
  });

  app.delete<{ Params: UploadParams }>(`${BASE}/uploads/:uploadId`, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
    await k.cancelUpload(request.params.id, request.params.baseId, request.params.uploadId);
    return reply.code(204).send();
  });

  app.get<DocParams>(`${BASE}/documents/:docId/content`, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
    const file = await k.original(request.params.id, request.params.baseId, request.params.docId);
    if (!file) return reply.code(404).send({ error: "document not found" });
    return reply
      .header("content-type", "application/octet-stream")
      .header("x-content-type-options", "nosniff")
      .header("content-disposition", contentDisposition(file.name))
      .header("cache-control", "private, no-store")
      .header("content-length", file.size)
      // Streamed: an original may be past what one buffer can hold.
      .send(createReadStream(file.path));
  });

  app.post<DocParams>(`${BASE}/documents/:docId/rebuild`, async (request, reply) => {
    const principal = await allowed(request, reply, request.params.id, "project.write");
    if (!principal) return reply;
    if (!(await k.rebuildGraph(request.params.id, request.params.baseId, request.params.docId, principal.userId))) {
      return reply.code(404).send({ error: "document not found" });
    }
    return reply.code(202).send({ ok: true });
  });

  app.delete<DocParams>(`${BASE}/documents/:docId`, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "project.write"))) return reply;
    if (!(await k.removeDocument(request.params.id, request.params.baseId, request.params.docId))) {
      return reply.code(404).send({ error: "document not found" });
    }
    return reply.code(204).send();
  });

  app.get<BaseParams>(`${BASE}/graph`, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
    const graph = await k.graph(request.params.id, request.params.baseId);
    if (!graph) return reply.code(404).send({ error: "knowledge base not found" });
    return { graph };
  });

  app.get<BaseParams & { Querystring: { q?: string } }>(`${BASE}/search`, async (request, reply) => {
    if (!(await allowed(request, reply, request.params.id, "workspace.view"))) return reply;
    const q = (request.query.q ?? "").trim().slice(0, 500);
    if (!q) return { hits: [] };
    return { hits: await k.search(request.params.id, [request.params.baseId], q) };
  });
}
