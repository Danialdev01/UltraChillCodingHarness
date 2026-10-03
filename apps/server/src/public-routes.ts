import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mediaTypeFor } from "@ucch/protocol";
import { PathError, type WorkspaceFiles } from "./files.js";
import type { GitService } from "./git.js";
import type { NotesService } from "./notes.js";
import type { UploadStore } from "./uploads.js";
import { PUBLIC_SLUG, type PublicProject } from "./workspaces.js";

export interface PublicRouteDeps {
  /** The project behind a public address, or null when there is none or it is off. */
  findPublic(slug: string): Promise<PublicProject | null>;
  notes: NotesService;
  files: WorkspaceFiles;
  git: GitService;
  uploads: UploadStore;
}

const LogQuery = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * A project's read-only public site, under `/api/public/:slug`.
 *
 * No session anywhere here: the slug is the whole grant, and the owner can
 * revoke it by switching the site off, at which point every route answers
 * 404 as though the address never existed. Nothing here writes, and nothing
 * here says the project's hash -- a visitor learns the name and the slug
 * they arrived with, no more.
 *
 * Only GETs, on purpose. Anything that would change the project belongs to
 * the owner's routes and their session.
 */
export function registerPublicRoutes(app: FastifyInstance, deps: PublicRouteDeps): void {
  const { findPublic, notes, files, git, uploads } = deps;

  type Slug = { slug: string };
  const notFound = { error: "not found" };

  async function projectFor(slug: string): Promise<PublicProject | null> {
    if (!PUBLIC_SLUG.test(slug)) return null;
    return findPublic(slug);
  }

  app.get<{ Params: Slug }>("/api/public/:slug", async (request, reply) => {
    const project = await projectFor(request.params.slug);
    if (!project) return reply.code(404).send(notFound);
    return { name: project.name, slug: project.slug };
  });

  app.get<{ Params: Slug }>("/api/public/:slug/notes", async (request, reply) => {
    const project = await projectFor(request.params.slug);
    if (!project) return reply.code(404).send(notFound);
    const list = await notes.list(project.id);
    return list.map((note) => ({ ...note, cover: note.cover && publicUrl(note.cover, project) }));
  });

  app.get<{ Params: Slug & { noteId: string } }>("/api/public/:slug/notes/:noteId", async (request, reply) => {
    const project = await projectFor(request.params.slug);
    if (!project) return reply.code(404).send(notFound);
    if (!z.string().uuid().safeParse(request.params.noteId).success) return reply.code(404).send(notFound);
    const note = await notes.get(project.id, request.params.noteId);
    if (!note) return reply.code(404).send(notFound);
    // Pictures in a page point at the owner's upload route; swap in this
    // site's copy of it so they load without a session and without the hash.
    return JSON.parse(rewriteUploadUrls(JSON.stringify(note), project));
  });

  app.get<{ Params: Slug & { id: string } }>("/api/public/:slug/uploads/:id/content", async (request, reply) => {
    const project = await projectFor(request.params.slug);
    if (!project) return reply.code(404).send(notFound);

    const upload = await uploads.find(project.id, request.params.id);
    if (!upload) return reply.code(404).send(notFound);
    // Only what can be shown inline as a picture: the public site is a
    // reader, and a page embeds nothing else.
    const mediaType = mediaTypeFor(upload.name);
    if (!mediaType?.startsWith("image/")) return reply.code(404).send(notFound);

    const file = await uploads.readBytes(project.id, request.params.id);
    if (!file) return reply.code(404).send(notFound);
    return reply
      .header("content-type", mediaType)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header("content-disposition", "inline")
      .header("cache-control", "public, max-age=300")
      .send(file.bytes);
  });

  app.get<{ Params: Slug }>("/api/public/:slug/files", async (request, reply) => {
    const project = await projectFor(request.params.slug);
    if (!project) return reply.code(404).send(notFound);
    return files.tree(project.id);
  });

  app.get<{ Params: Slug; Querystring: { path?: string } }>("/api/public/:slug/file", async (request, reply) => {
    const project = await projectFor(request.params.slug);
    if (!project) return reply.code(404).send(notFound);
    const path = request.query.path;
    if (!path) return reply.code(400).send({ error: "a path is required" });
    try {
      const result = await files.read(project.id, path);
      switch (result.kind) {
        case "text":
          return { path, content: result.content };
        case "missing":
          return reply.code(404).send(notFound);
        case "directory":
          return reply.code(400).send({ error: "that is a directory" });
        case "binary":
          return reply.code(415).send({ error: "this file is not text" });
        case "too_large":
          return reply.code(413).send({ error: "this file is too large to show" });
      }
    } catch (error) {
      if (error instanceof PathError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: Slug; Querystring: unknown }>("/api/public/:slug/log", async (request, reply) => {
    const project = await projectFor(request.params.slug);
    if (!project) return reply.code(404).send(notFound);
    const query = LogQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "bad paging" });
    if (!(await git.isRepo(project.id))) return { commits: [], hasMore: false, isShallow: false };
    return git.log(project.id, query.data);
  });
}

/** The owner's upload URL for this project, re-addressed to the public site. */
export function publicUrl(url: string, project: PublicProject): string {
  return url.replace(`/api/projects/${project.hash}/uploads/`, `/api/public/${project.slug}/uploads/`);
}

export function rewriteUploadUrls(json: string, project: PublicProject): string {
  return json.split(`/api/projects/${project.hash}/uploads/`).join(`/api/public/${project.slug}/uploads/`);
}
