import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  NOTE_CONTENT_MAX_BYTES,
  NOTE_TITLE_MAX,
  mediaTypeFor,
  noteText,
  type ChangeOrigin,
  type DomainEvent,
} from "@ucch/protocol";
import { textDelta, type AuditInput } from "./audit.js";
import type { NoteRecord, NotesService, NoteWriteOutcome } from "./notes.js";
import { PathError, type UploadStore } from "./uploads.js";
import type { ProjectSummary } from "./workspaces.js";

export type NoteChangedEvent = Extract<DomainEvent, { type: "note.changed" }>;

type ProjectRequest = {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  params: { hash: string };
};

/**
 * The most a page body may be and still travel inside its own change notice.
 * Larger ones are left out and the tabs that want them refetch.
 */
const PUSHED_CONTENT_MAX_BYTES = 256 * 1024;

export interface NoteRouteDeps {
  /** The caller's project for `:hash`, or null -- the same gate every project route uses. */
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  notes: NotesService;
  /** Images pasted into a page are staged here and retained past the sweep. */
  uploads: UploadStore;
  /** Tells the project's other open tabs something changed. Never throws. */
  announce(event: NoteChangedEvent): Promise<void>;
  /** The most an image may be, matching the upload parser's body limit. */
  maxImageBytes: number;
  /** Who is asking, and from which tab. */
  originOf(request: ProjectRequest): Promise<ChangeOrigin | undefined>;
  /** Writes a line to the project's activity log. Never throws. */
  audit(input: AuditInput): Promise<unknown>;
  /**
   * Replaces a page's body through the collab service, so every open editor
   * receives it as an ordinary edit and it is saved before this returns.
   * False when the service could not be reached: the body is then written
   * here, and the page's collaborative state is dropped to be seeded again.
   */
  writeContent?(noteId: string, content: z.infer<typeof NoteDoc>): Promise<boolean>;
}

const NoteId = z.string().uuid();

const NoteDoc = z.object({ type: z.literal("doc"), content: z.array(z.unknown()).optional() });

const NoteCreate = z.object({
  parentId: NoteId,
  title: z.string().max(NOTE_TITLE_MAX).optional(),
  afterId: NoteId.optional(),
});

const NotePatch = z
  .object({
    title: z.string().max(NOTE_TITLE_MAX).optional(),
    icon: z.string().max(16).nullable().optional(),
    cover: z.string().max(2048).refine(isCoverUrl).nullable().optional(),
    content: NoteDoc.optional(),
    ifUpdatedAt: z.string().datetime().optional(),
  })
  .refine(
    (p) =>
      p.title !== undefined ||
      p.icon !== undefined ||
      p.cover !== undefined ||
      p.content !== undefined,
    { message: "nothing to change" },
  );

/**
 * A cover is an image this server serves, or one on the web; never a
 * `javascript:` or data URL, which the banner would otherwise load.
 */
function isCoverUrl(url: string): boolean {
  return /^\/api\/projects\/[a-z0-9]+\/uploads\/[^/?#]+\/content$/.test(url) || url.startsWith("https://");
}

const NoteSearch = z.object({ q: z.string().trim().min(1).max(200) });

const NoteMove = z.object({
  parentId: NoteId,
  position: z.number().int().min(0),
  /** Where the page was when it was picked up; a move from anywhere else is refused. */
  ifParentId: NoteId.optional(),
});

/** Which of a patch's fields were sent, for the activity log. */
function changedFields(patch: Record<string, unknown>): string[] {
  return ["title", "icon", "cover", "content"].filter((key) => patch[key] !== undefined);
}

/**
 * A project's notes, under `/api/projects/:hash/notes`.
 *
 * Its own module because it is a feature with a whole small API rather than
 * one route, and `index.ts` is long enough. The dependencies come in as
 * arguments so this file has no module-level state and can be registered
 * once the app's own services exist.
 */
export function registerNoteRoutes(app: FastifyInstance, deps: NoteRouteDeps): void {
  const { projectFor, notes, uploads, announce, originOf, audit, writeContent } = deps;

  /** The activity-log fields every entry here shares. */
  const by = (projectId: string, origin: ChangeOrigin | undefined) => ({
    projectId,
    userId: origin?.userId ?? null,
    clientId: origin?.clientId ?? null,
    targetType: "note",
  });

  type Hash = { hash: string };
  type HashAndNote = { hash: string; noteId: string };

  const notFound = { error: "project not found" };

  app.get<{ Params: Hash }>("/api/projects/:hash/notes", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const root = await notes.ensureRoot(project.id, project.name);
    return { notes: await notes.list(project.id), rootId: root.id };
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/notes", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const parsed = NoteCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "a parent page is required" });

    const note = await notes.create(project.id, parsed.data);
    if (!note) return reply.code(404).send({ error: "that parent page does not exist" });
    const origin = await originOf(request);
    await announce({
      type: "note.changed",
      projectId: project.id,
      noteId: note.id,
      change: "created",
      updatedAt: note.updatedAt,
      ...(origin ? { origin } : {}),
    });
    void audit({
      ...by(project.id, origin),
      action: "note.create",
      targetId: note.id,
      summary: `Created page “${note.title}”`,
      details: { parentId: note.parentId },
    });
    return reply.code(201).send({ note });
  });

  // Registered before `/:noteId` on purpose, though the router would pick the
  // static segment anyway; the uuid check on `:noteId` is the real guarantee.
  app.post<{ Params: Hash; Querystring: { name?: string; type?: string } }>(
    "/api/projects/:hash/notes/assets",
    { bodyLimit: deps.maxImageBytes },
    async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: "send the image as application/octet-stream" });
      }
      const name = request.query.name;
      if (!name) return reply.code(400).send({ error: "a name is required" });
      // Only what `/uploads/:id/content` will serve inline as a picture: the
      // route decides by extension, so refuse here what it would refuse there.
      if (!mediaTypeFor(name)?.startsWith("image/")) {
        return reply.code(415).send({ error: "only images can be placed in a page" });
      }

      try {
        const upload = await uploads.stage(
          project.id,
          name,
          request.query.type ?? "application/octet-stream",
          request.body,
        );
        // A picture in a page is not working memory: it has to be there
        // next month. Retained uploads outlive the staging sweep.
        await uploads.retain(project.id, upload.id);
        return reply.code(201).send({ upload });
      } catch (error) {
        if (error instanceof PathError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    },
  );

  app.get<{ Params: Hash; Querystring: { q?: string } }>(
    "/api/projects/:hash/notes/search",
    async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      const parsed = NoteSearch.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "something to search for is required" });
      return { hits: await notes.search(project.id, parsed.data.q) };
    },
  );

  app.get<{ Params: HashAndNote }>("/api/projects/:hash/notes/:noteId", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!NoteId.safeParse(request.params.noteId).success) {
      return reply.code(404).send({ error: "that page does not exist" });
    }
    const note = await notes.get(project.id, request.params.noteId);
    if (!note) return reply.code(404).send({ error: "that page does not exist" });
    return { note };
  });

  app.patch<{ Params: HashAndNote }>("/api/projects/:hash/notes/:noteId", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!NoteId.safeParse(request.params.noteId).success) {
      return reply.code(404).send({ error: "that page does not exist" });
    }
    const parsed = NotePatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "nothing to change" });
    if (
      parsed.data.content &&
      Buffer.byteLength(JSON.stringify(parsed.data.content)) > NOTE_CONTENT_MAX_BYTES
    ) {
      return reply.code(413).send({
        error: `the page is larger than the ${Math.round(NOTE_CONTENT_MAX_BYTES / (1024 * 1024))} MB limit`,
      });
    }

    const outcome = await writeNote(project.id, request.params.noteId, parsed.data);
    if (!outcome) return reply.code(404).send({ error: "that page does not exist" });
    const viaCollab = "viaCollab" in outcome && outcome.viaCollab;
    const origin = await originOf(request);
    if ("conflict" in outcome) {
      // Logged too: a revert the person saw should be in the history, so
      // "where did my paragraph go" has an answer.
      void audit({
        ...by(project.id, origin),
        action: "note.conflict",
        targetId: outcome.conflict.id,
        summary: `Edit to “${outcome.conflict.title}” refused: changed elsewhere, reverted`,
        details: { fields: changedFields(parsed.data) },
      });
      return reply.code(409).send({ error: "the page changed elsewhere", note: outcome.conflict });
    }
    const { note } = outcome;
    const fields: NonNullable<NoteChangedEvent["fields"]> = {};
    if (parsed.data.title !== undefined) fields.title = note.title;
    if (parsed.data.icon !== undefined) fields.icon = note.icon;
    if (parsed.data.cover !== undefined) fields.cover = note.cover;
    // Through the collab service, open editors already have the body, and
    // its save announced it.
    if (parsed.data.content !== undefined && !viaCollab) {
      if (Buffer.byteLength(JSON.stringify(note.content)) <= PUSHED_CONTENT_MAX_BYTES) {
        fields.content = note.content;
      } else {
        fields.contentOmitted = true;
      }
    }
    await announce({
      type: "note.changed",
      projectId: project.id,
      noteId: note.id,
      change: "updated",
      updatedAt: note.updatedAt,
      ...(origin ? { origin } : {}),
      fields,
    });
    const renamed = parsed.data.title !== undefined && outcome.before.title !== note.title;
    void audit({
      ...by(project.id, origin),
      action: renamed ? "note.rename" : "note.update",
      targetId: note.id,
      summary: renamed
        ? `Renamed “${outcome.before.title}” to “${note.title}”`
        : `Edited “${note.title}”`,
      details: {
        fields: changedFields(parsed.data),
        ...(renamed ? { from: outcome.before.title, to: note.title } : {}),
        ...(parsed.data.content !== undefined
          ? textDelta(outcome.before.text, noteText(note.content))
          : {}),
      },
      coalesce: true,
    });
    const { content: _content, ...summary } = outcome.note;
    return { note: summary };
  });

  /**
   * A PATCH's writes: the body through the collab service when there is one
   * (`writeContent`), everything else -- and the body when the service is
   * down -- straight to the row.
   */
  async function writeNote(
    projectId: string,
    noteId: string,
    patch: z.infer<typeof NotePatch>,
  ): Promise<NoteWriteOutcome | { note: NoteRecord; before: { title: string; text: string }; viaCollab: true }> {
    if (patch.content === undefined || !writeContent) return notes.update(projectId, noteId, patch);
    const current = await notes.get(projectId, noteId);
    if (!current) return null;
    if (patch.ifUpdatedAt && current.updatedAt !== new Date(patch.ifUpdatedAt).toISOString()) {
      return { conflict: current };
    }
    if (!(await writeContent(noteId, patch.content))) return notes.update(projectId, noteId, patch);

    const before = { title: current.title, text: noteText(current.content) };
    const { content: _content, ifUpdatedAt: _ifUpdatedAt, ...rest } = patch;
    const others = rest.title !== undefined || rest.icon !== undefined || rest.cover !== undefined;
    const written = others ? await notes.update(projectId, noteId, rest) : null;
    if (written && "conflict" in written) return written;
    const note = written?.note ?? (await notes.get(projectId, noteId));
    return note ? { note, before, viaCollab: true } : null;
  }

  app.post<{ Params: HashAndNote }>(
    "/api/projects/:hash/notes/:noteId/move",
    async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      if (!NoteId.safeParse(request.params.noteId).success) {
        return reply.code(404).send({ error: "that page does not exist" });
      }
      const parsed = NoteMove.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "a destination is required" });

      const result = await notes.move(project.id, request.params.noteId, parsed.data);
      if (result === null) return reply.code(404).send({ error: "that page does not exist" });
      if (result === "conflict") {
        return reply
          .code(409)
          .send({ error: "that page was moved elsewhere in the meantime", notes: await notes.list(project.id) });
      }
      if (result === "root") return reply.code(400).send({ error: "the root page cannot be moved" });
      if (result === "cycle") {
        return reply.code(400).send({ error: "a page cannot be moved inside itself" });
      }
      const origin = await originOf(request);
      await announce({
        type: "note.changed",
        projectId: project.id,
        noteId: request.params.noteId,
        change: "moved",
        updatedAt: new Date().toISOString(),
        ...(origin ? { origin } : {}),
      });
      const moved = result.find((n) => n.id === request.params.noteId);
      const parent = result.find((n) => n.id === parsed.data.parentId);
      void audit({
        ...by(project.id, origin),
        action: "note.move",
        targetId: request.params.noteId,
        summary: `Moved “${moved?.title ?? "a page"}” under “${parent?.title ?? "a page"}”`,
        details: { parentId: parsed.data.parentId, position: parsed.data.position },
      });
      return { notes: result };
    },
  );

  app.delete<{ Params: HashAndNote }>(
    "/api/projects/:hash/notes/:noteId",
    async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      if (!NoteId.safeParse(request.params.noteId).success) {
        return reply.code(404).send({ error: "that page does not exist" });
      }
      const result = await notes.remove(project.id, request.params.noteId);
      if (result === false) return reply.code(404).send({ error: "that page does not exist" });
      if (result === "root") return reply.code(400).send({ error: "the root page cannot be deleted" });
      const origin = await originOf(request);
      await announce({
        type: "note.changed",
        projectId: project.id,
        noteId: request.params.noteId,
        change: "deleted",
        updatedAt: new Date().toISOString(),
        ...(origin ? { origin } : {}),
        parentId: result.parentId,
      });
      void audit({
        ...by(project.id, origin),
        action: "note.delete",
        targetId: request.params.noteId,
        summary: `Deleted page “${result.title}”`,
        details: { parentId: result.parentId },
      });
      return { ok: true };
    },
  );
}
