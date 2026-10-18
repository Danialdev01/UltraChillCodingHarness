/**
 * A project's live preview, over the API.
 *
 * The owner sets a port, or a folder of static files; where the dev server is and
 * what the public address looks like are the server's to decide, so both
 * come back in the project rather than being assembled here.
 */

import type { Project } from "@/lib/session";

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

/** Sets the dev server's port, or clears the preview with null. Returns the project with its URLs. */
export function setPreviewPort(hash: string, port: number | null): Promise<Project> {
  return putPreview(hash, { port });
}

/**
 * Serves a folder of the working tree as a static site, "" for the root.
 * The server picks the subdomain's port when the project has none yet.
 */
export function setStaticPreview(hash: string, dir: string): Promise<Project> {
  return putPreview(hash, { port: null, staticDir: dir });
}

async function putPreview(
  hash: string,
  body: { port: number | null; staticDir?: string },
): Promise<Project> {
  const response = await fetch(`/api/projects/${hash}/preview`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await fail(response, "Could not save the preview.");
  return (await response.json()) as Project;
}

export interface PreviewStatus {
  port: number;
  /** Set for a static site, whose `listening` means it has an index.html. */
  staticDir: string | null;
  listening: boolean;
}

/** Whether the preview has something to show right now. */
export async function fetchPreviewStatus(hash: string): Promise<PreviewStatus> {
  const response = await fetch(`/api/projects/${hash}/preview/status`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not check the preview.");
  return (await response.json()) as PreviewStatus;
}
