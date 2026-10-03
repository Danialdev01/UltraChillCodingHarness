import type { GitLogPage } from "@ucch/protocol";

import type { FileNode } from "./files-api";
import type { Note, NoteSummary } from "./notes-api";

/**
 * A project's public site, over the API.
 *
 * Every call is a GET against `/api/public/{slug}` and sends no credentials:
 * the slug is the whole grant. Server components call `fetchPublicProject`
 * with the server origin; the client-side readers call the rest through the
 * same-origin proxy.
 */

export interface PublicProject {
  name: string;
  slug: string;
}

export class PublicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PublicApiError";
  }
}

async function get<T>(base: string, slug: string, path: string, fallback: string): Promise<T> {
  const response = await fetch(`${base}/api/public/${slug}${path}`, { cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new PublicApiError(body.error ?? fallback, response.status);
  }
  return (await response.json()) as T;
}

/** From a server component: null when there is no such site or it is off. */
export async function fetchPublicProject(slug: string): Promise<PublicProject | null> {
  const origin = process.env.SERVER_ORIGIN ?? "http://127.0.0.1:3001";
  try {
    return await get<PublicProject>(origin, slug, "", "not found");
  } catch {
    return null;
  }
}

export const fetchPublicNotes = (slug: string) =>
  get<NoteSummary[]>("", slug, "/notes", "Could not load the pages.");

export const fetchPublicNote = (slug: string, noteId: string) =>
  get<Note>("", slug, `/notes/${noteId}`, "Could not load the page.");

export const fetchPublicTree = (slug: string) =>
  get<{ tree: FileNode[]; truncated: boolean }>("", slug, "/files", "Could not load the files.");

export const fetchPublicFile = (slug: string, path: string) =>
  get<{ path: string; content: string }>("", slug, `/file?path=${encodeURIComponent(path)}`, "Could not open the file.");

export const fetchPublicLog = (slug: string, skip = 0, limit = 50) =>
  get<GitLogPage>("", slug, `/log?skip=${skip}&limit=${limit}`, "Could not load the history.");

/** The visitor-facing address of a page of the site. */
export function publicHref(slug: string, ...segments: string[]): string {
  return `/${slug}${segments.length ? "/" + segments.map(encodeURIComponent).join("/") : ""}`;
}

// ---- the owner's side -------------------------------------------------------

/** Whether a project's public site is on, and where it is. */
export interface PublicSiteState {
  enabled: boolean;
  slug: string | null;
  /** The full address to share, or null until the site has been enabled once. */
  url: string | null;
}

async function owner<T>(hash: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/projects/${hash}/public`, { credentials: "include", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new PublicApiError(body.error ?? "Could not update the public site.", response.status);
  }
  return (await response.json()) as T;
}

export const fetchPublicSite = (hash: string) => owner<PublicSiteState>(hash);

export const setPublicSite = (hash: string, enabled: boolean) =>
  owner<PublicSiteState>(hash, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
