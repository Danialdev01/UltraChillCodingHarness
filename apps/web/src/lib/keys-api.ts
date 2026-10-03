/**
 * A project's saved keys, over the API.
 *
 * Mirrors the server's `ProjectKeyService`. A listed key never carries its
 * value: `revealProjectKey` fetches one value, on demand, when the person
 * asks to see or copy it.
 */

export interface ProjectKey {
  id: string;
  name: string;
  tags: string[];
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectKeyInput {
  name: string;
  value: string;
  tags?: string[];
  url?: string | null;
}

export type ProjectKeyPatch = Partial<ProjectKeyInput>;

/** The server's message, or a fallback, as one throwable thing. */
async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

const json = { "content-type": "application/json" };

export async function listProjectKeys(hash: string): Promise<ProjectKey[]> {
  const response = await fetch(`/api/projects/${hash}/keys`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not load the keys.");
  return ((await response.json()) as { keys: ProjectKey[] }).keys;
}

export async function createProjectKey(hash: string, input: ProjectKeyInput): Promise<ProjectKey> {
  const response = await fetch(`/api/projects/${hash}/keys`, {
    method: "POST",
    credentials: "include",
    headers: json,
    body: JSON.stringify(input),
  });
  if (!response.ok) await fail(response, "Could not save the key.");
  return ((await response.json()) as { key: ProjectKey }).key;
}

export async function updateProjectKey(
  hash: string,
  keyId: string,
  patch: ProjectKeyPatch,
): Promise<ProjectKey> {
  const response = await fetch(`/api/projects/${hash}/keys/${keyId}`, {
    method: "PATCH",
    credentials: "include",
    headers: json,
    body: JSON.stringify(patch),
  });
  if (!response.ok) await fail(response, "Could not save the key.");
  return ((await response.json()) as { key: ProjectKey }).key;
}

export async function deleteProjectKey(hash: string, keyId: string): Promise<void> {
  const response = await fetch(`/api/projects/${hash}/keys/${keyId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) await fail(response, "Could not remove the key.");
}

export async function revealProjectKey(hash: string, keyId: string): Promise<string> {
  const response = await fetch(`/api/projects/${hash}/keys/${keyId}/value`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) await fail(response, "Could not read the key.");
  return ((await response.json()) as { value: string }).value;
}

/** "openai, prod , billing" -> ["openai", "prod", "billing"], blanks and repeats dropped. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))];
}
