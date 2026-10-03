/**
 * The project's real files, over the API.
 *
 * Everything here is a thin call to `/api/projects/{hash}/file(s)`, which
 * reads and writes `WORKSPACE_ROOT/{projectId}` on the server -- the same
 * directory the agent's tools work in, so what the tree shows is what the
 * model sees. Nothing is cached here; the panel holds the tree and the
 * editor holds the buffers, and both refetch when a change is announced.
 */

/** A directory is `{ name, children }`; a file is `{ name }`. */
export interface FileNode {
  name: string;
  children?: FileNode[];
}

/** The server's message, or a fallback, as one throwable thing. */
async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

export async function fetchTree(hash: string): Promise<{ tree: FileNode[]; truncated: boolean }> {
  const response = await fetch(`/api/projects/${hash}/files`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not read the project's files.");
  return (await response.json()) as { tree: FileNode[]; truncated: boolean };
}

export async function fetchFile(hash: string, path: string): Promise<string> {
  return (await fetchFileVersion(hash, path)).content;
}

/** A file's text and the version naming it, for a save that must not overwrite another. */
export async function fetchFileVersion(
  hash: string,
  path: string,
): Promise<{ content: string; version: string | null }> {
  const response = await fetch(
    `/api/projects/${hash}/file?path=${encodeURIComponent(path)}`,
    { credentials: "include" },
  );
  if (!response.ok) await fail(response, "Could not open the file.");
  const body = (await response.json()) as { content: string; version?: string };
  return { content: body.content, version: body.version ?? null };
}

/** A save refused because the file changed elsewhere; carries what is there now. */
export class FileConflictError extends Error {
  constructor(
    message: string,
    /** The file as it is now, or null when it was deleted. */
    readonly content: string | null,
    readonly version: string | null,
  ) {
    super(message);
    this.name = "FileConflictError";
  }
}

/**
 * Saves a file. With `ifVersion`, only over that version: throws
 * `FileConflictError` when another window or the agent changed it since.
 * Resolves with the new version.
 */
export async function saveFile(
  hash: string,
  path: string,
  content: string,
  ifVersion?: string | null,
): Promise<string | null> {
  const response = await fetch(`/api/projects/${hash}/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ path, content, ...(ifVersion ? { ifVersion } : {}) }),
  });
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      content?: string | null;
      version?: string | null;
    };
    if ("content" in body) {
      throw new FileConflictError(
        body.error ?? "This file was changed elsewhere.",
        body.content ?? null,
        body.version ?? null,
      );
    }
  }
  if (!response.ok) await fail(response, "Could not save the file.");
  return ((await response.json()) as { version?: string }).version ?? null;
}

export async function createEntry(
  hash: string,
  path: string,
  kind: "file" | "directory",
): Promise<void> {
  const response = await fetch(`/api/projects/${hash}/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ path, kind }),
  });
  if (!response.ok) await fail(response, `Could not create ${path}.`);
}

/** Renames or relocates a file or folder, contents and all. */
export async function moveEntry(hash: string, from: string, to: string): Promise<void> {
  const response = await fetch(`/api/projects/${hash}/file`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ from, to }),
  });
  if (!response.ok) await fail(response, `Could not move ${from}.`);
}

export async function deleteEntry(hash: string, path: string): Promise<void> {
  const response = await fetch(
    `/api/projects/${hash}/file?path=${encodeURIComponent(path)}`,
    { method: "DELETE", credentials: "include" },
  );
  if (!response.ok) await fail(response, `Could not delete ${path}.`);
}

/**
 * Where the browser fetches a file's bytes for the image and PDF preview.
 *
 * A URL rather than a fetch: `<img>` and `<iframe>` load it themselves, and
 * the response's own headers -- its media type and the CSP that sandboxes it
 * -- are what make displaying a workspace file safe. Routing it through a
 * blob would strip exactly those.
 */
export function rawFileUrl(hash: string, path: string): string {
  return `/api/projects/${hash}/file/raw?path=${encodeURIComponent(path)}`;
}

/** "app/page.tsx" -> "page.tsx" */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The folder a path sits in: "app/page.tsx" -> "app", "page.tsx" -> "". */
export function dirname(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

/** Whether `path` is a folder in this tree. */
export function isFolder(nodes: readonly FileNode[], path: string, prefix = ""): boolean {
  for (const node of nodes) {
    const here = prefix ? `${prefix}/${node.name}` : node.name;
    if (here === path) return Boolean(node.children);
    if (node.children && path.startsWith(`${here}/`)) return isFolder(node.children, path, here);
  }
  return false;
}
