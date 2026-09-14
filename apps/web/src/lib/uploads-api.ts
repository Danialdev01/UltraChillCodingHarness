/**
 * Attachments, over the API.
 *
 * A picked file is sent to the server the moment it is chosen and held in
 * staging -- outside the project's working directory -- until something
 * places it. The composer therefore never carries bytes: a message references
 * an upload by id, and the agent's `attach_upload` tool (or `attachUpload`
 * below) is what moves it into the project.
 */

/** One staged file. Mirrors the server's `StagedUpload`. */
export interface StagedUpload {
  id: string;
  name: string;
  size: number;
  contentType: string;
  stagedAt: string;
}

/** The server's message, or a fallback, as one throwable thing. */
async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

/**
 * Sends one file to staging.
 *
 * The body is the file itself as `application/octet-stream`, with the name
 * and type in the query string -- the server parses one buffer rather than a
 * multipart envelope, and there is no form to build here.
 */
export async function stageUpload(hash: string, file: File): Promise<StagedUpload> {
  const query = new URLSearchParams({ name: file.name, type: file.type || "" });
  const response = await fetch(`/api/projects/${hash}/uploads?${query}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!response.ok) await fail(response, `Could not upload ${file.name}.`);
  return ((await response.json()) as { upload: StagedUpload }).upload;
}

/**
 * Where a staged attachment's bytes are, for an `<img>`, an `<iframe>`, or a
 * download link.
 *
 * A URL rather than a fetch: the elements that show a file take a `src`, and
 * the browser's own download needs an `href`. `download` switches the server
 * to `application/octet-stream` with a filename, which is what makes it a
 * saved file rather than something the browser tries to render.
 */
export function uploadContentUrl(
  hash: string,
  uploadId: string,
  options: { download?: boolean } = {},
): string {
  const query = options.download ? "?download=1" : "";
  return `/api/projects/${hash}/uploads/${encodeURIComponent(uploadId)}/content${query}`;
}

/** One staged attachment read as text, for previewing a file that is not a picture. */
export interface UploadText {
  name: string;
  size: number;
  text: string;
  /** True when the file was longer than the preview shows. */
  truncated: boolean;
}

/**
 * A staged attachment's text.
 *
 * Separate from `uploadContentUrl` because the text comes back as JSON and is
 * put into an element as a string -- the server will not serve a text file
 * inline, so there is nothing here that a `.html` attachment could turn into a
 * document on this origin.
 */
export async function fetchUploadText(hash: string, uploadId: string): Promise<UploadText> {
  const response = await fetch(
    `/api/projects/${hash}/uploads/${encodeURIComponent(uploadId)}/text`,
    { credentials: "include" },
  );
  if (!response.ok) await fail(response, "Could not read that attachment.");
  return (await response.json()) as UploadText;
}

/** Everything still staged for a project. */
export async function listUploads(hash: string): Promise<StagedUpload[]> {
  const response = await fetch(`/api/projects/${hash}/uploads`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not list staged uploads.");
  return ((await response.json()) as { uploads: StagedUpload[] }).uploads;
}

/**
 * Moves a staged file into the project working directory.
 *
 * `path` is optional: with none, the file lands at the workspace root under
 * its own name.
 */
export async function attachUpload(
  hash: string,
  uploadId: string,
  path?: string,
): Promise<{ path: string; size: number }> {
  const response = await fetch(`/api/projects/${hash}/uploads/${uploadId}/attach`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(path ? { path } : {}),
  });
  if (!response.ok) await fail(response, "Could not add the file to the project.");
  return (await response.json()) as { path: string; size: number };
}

/**
 * Drops a staged file.
 *
 * Best-effort by design: this is called when a chip is removed from the
 * composer, and a staged file that outlives its chip is swept on its own.
 * Failing the interaction over it would be worse than leaving it.
 */
export async function discardUpload(hash: string, uploadId: string): Promise<void> {
  await fetch(`/api/projects/${hash}/uploads/${uploadId}`, {
    method: "DELETE",
    credentials: "include",
  }).catch(() => {});
}
