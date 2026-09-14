/**
 * A project's live preview, over the API.
 *
 * The port is the only thing the owner sets; where the dev server is and
 * what the public address looks like are the server's to decide, so both
 * come back in the project rather than being assembled here.
 */

import type { Project } from "@/lib/session";

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

/** Sets the dev server's port, or clears it with null. Returns the project with its URLs. */
export async function setPreviewPort(hash: string, port: number | null): Promise<Project> {
  const response = await fetch(`/api/projects/${hash}/preview`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ port }),
  });
  if (!response.ok) await fail(response, "Could not save the preview port.");
  return (await response.json()) as Project;
}

/** Whether anything is listening on the saved port right now. */
export async function fetchPreviewStatus(hash: string): Promise<{ port: number; listening: boolean }> {
  const response = await fetch(`/api/projects/${hash}/preview/status`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not check the preview.");
  return (await response.json()) as { port: number; listening: boolean };
}
