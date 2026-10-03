/**
 * A project's notes, over the API.
 *
 * Mirrors the server's `NotesService`: a tree of pages, one root, with the
 * body fetched one page at a time because it can be large. Images pasted into
 * a page go through the upload store and are served by its content route, so
 * an `<img>` in a note points at the same URL an attachment in the chat does.
 */

import type { NoteDoc } from "@ucch/protocol";
import { uploadContentUrl, type StagedUpload } from "./uploads-api";

/** A note as the tree lists it: everything but the body. */
export interface NoteSummary {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  /** The banner image above the title, as a URL, or null. */
  cover: string | null;
  position: number;
  updatedAt: string;
}

/** A page a search found; `snippet` is the text around a match in the body. */
export interface NoteSearchHit {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  snippet: string;
}

/** A note with its body, as the editor opens it. */
export interface Note extends NoteSummary {
  content: NoteDoc;
  createdAt: string;
}

export interface NotePatch {
  title?: string;
  icon?: string | null;
  cover?: string | null;
  content?: NoteDoc;
  /** The `updatedAt` last seen; the server refuses to overwrite anything newer. */
  ifUpdatedAt?: string;
}

/**
 * The page changed under this tab.
 *
 * Carries the current note so the caller can show what it lost to, or
 * reload from it, without another round trip.
 */
export class NoteConflictError extends Error {
  constructor(readonly note: Note) {
    super("the page changed elsewhere");
    this.name = "NoteConflictError";
  }
}

/** The server's message, or a fallback, as one throwable thing. */
async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

const json = { "content-type": "application/json" };

/** Every page in the project. The root is created on first call. */
export async function listNotes(hash: string): Promise<{ notes: NoteSummary[]; rootId: string }> {
  const response = await fetch(`/api/projects/${hash}/notes`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not load the notes.");
  return (await response.json()) as { notes: NoteSummary[]; rootId: string };
}

export async function fetchNote(hash: string, noteId: string): Promise<Note> {
  const response = await fetch(`/api/projects/${hash}/notes/${noteId}`, {
    credentials: "include",
  });
  if (!response.ok) await fail(response, "Could not open that page.");
  return ((await response.json()) as { note: Note }).note;
}

export async function createNote(
  hash: string,
  input: { parentId: string; title?: string; afterId?: string },
): Promise<Note> {
  const response = await fetch(`/api/projects/${hash}/notes`, {
    method: "POST",
    credentials: "include",
    headers: json,
    body: JSON.stringify(input),
  });
  if (!response.ok) await fail(response, "Could not create the page.");
  return ((await response.json()) as { note: Note }).note;
}

/**
 * Writes part of a page.
 *
 * `keepalive` so a save started as the tab closes still reaches the server:
 * autosave flushes on `beforeunload`, and an ordinary fetch is cancelled with
 * the document. Throws `NoteConflictError` when `ifUpdatedAt` is stale.
 */
export async function updateNote(
  hash: string,
  noteId: string,
  patch: NotePatch,
): Promise<NoteSummary> {
  const response = await fetch(`/api/projects/${hash}/notes/${noteId}`, {
    method: "PATCH",
    credentials: "include",
    headers: json,
    body: JSON.stringify(patch),
    keepalive: true,
  });
  if (response.status === 409) {
    const body = (await response.json()) as { note: Note };
    throw new NoteConflictError(body.note);
  }
  if (!response.ok) await fail(response, "Could not save the page.");
  return ((await response.json()) as { note: NoteSummary }).note;
}

/** A move refused because the page had been moved elsewhere since; carries the tree as it is. */
export class NoteMoveConflictError extends Error {
  constructor(readonly notes: NoteSummary[]) {
    super("that page was moved elsewhere in the meantime");
    this.name = "NoteMoveConflictError";
  }
}

/**
 * Reparents or reorders a page. Returns the whole tree, since positions
 * shift. With `ifParentId`, only from that parent: throws
 * `NoteMoveConflictError` when another tab has moved it since.
 */
export async function moveNote(
  hash: string,
  noteId: string,
  to: { parentId: string; position: number; ifParentId?: string },
): Promise<NoteSummary[]> {
  const response = await fetch(`/api/projects/${hash}/notes/${noteId}/move`, {
    method: "POST",
    credentials: "include",
    headers: json,
    body: JSON.stringify(to),
  });
  if (response.status === 409) {
    throw new NoteMoveConflictError(((await response.json()) as { notes: NoteSummary[] }).notes);
  }
  if (!response.ok) await fail(response, "Could not move the page.");
  return ((await response.json()) as { notes: NoteSummary[] }).notes;
}

/** Pages whose title or body contains `query`. */
export async function searchNotes(hash: string, query: string): Promise<NoteSearchHit[]> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`/api/projects/${hash}/notes/search?${params}`, {
    credentials: "include",
  });
  if (!response.ok) await fail(response, "Could not search the notes.");
  return ((await response.json()) as { hits: NoteSearchHit[] }).hits;
}

/** Deletes a page and everything under it. */
export async function deleteNote(hash: string, noteId: string): Promise<void> {
  const response = await fetch(`/api/projects/${hash}/notes/${noteId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) await fail(response, "Could not delete the page.");
}

/**
 * Puts an image where a page can point at it, and returns that URL.
 *
 * The same octet-stream shape as `stageUpload`; the server keeps the file
 * past the staging sweep, since a page is not a conversation. The name
 * decides the served media type, so a clipboard blob -- which has a type but
 * no name -- gets one from its type.
 */
export async function uploadNoteImage(hash: string, file: File | Blob): Promise<string> {
  const name = imageFileName(file);
  const query = new URLSearchParams({ name, type: file.type || "" });
  const response = await fetch(`/api/projects/${hash}/notes/assets?${query}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!response.ok) await fail(response, `Could not upload ${name}.`);
  const { upload } = (await response.json()) as { upload: StagedUpload };
  return uploadContentUrl(hash, upload.id);
}

/**
 * A filename the server's extension allow-list will accept, for a pasted
 * image that came without one.
 */
export function imageFileName(file: File | Blob, now = Date.now()): string {
  const given = "name" in file && typeof file.name === "string" ? file.name : "";
  if (/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(given)) return given;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") || "png";
  return `pasted-${now}.${ext}`;
}
