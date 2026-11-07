/**
 * A project's environment variables and its project key, over the API.
 *
 * Mirrors the server's `EnvVarService`. The variables live in the project's
 * `.agent/env.val`, their values encrypted under the project key, so every
 * call that touches a value carries the key -- in the body, never the URL.
 * A listed variable never carries its value: `revealEnvVar` fetches one, on
 * demand, when the person asks to see or copy it.
 */

export interface EnvVar {
  id: string
  name: string
  tags: string[]
  url: string | null
  createdAt: string
  updatedAt: string
}

export interface EnvVarInput {
  name: string
  value: string
  tags?: string[]
  url?: string | null
}

export type EnvVarPatch = Partial<EnvVarInput>

export interface EnvList {
  /** The project has a project key; without one the section is not enabled. */
  configured: boolean
  vars: EnvVar[]
}

export interface ProjectKeyStatus {
  configured: boolean
  /** Keys saved before environment variables moved into `.agent/env.val`. */
  legacyCount: number
}

/** A failed call, with the server's code when it gave one (`wrong_project_key`, `not_configured`). */
export class EnvApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string }
  const message = response.status === 403 && body.code === "wrong_project_key" ? "That is not the project key." : body.error
  throw new EnvApiError(message ?? fallback, response.status, body.code)
}

/** True for the answer to a wrong project key. */
export function isWrongKey(error: unknown): boolean {
  return error instanceof EnvApiError && error.code === "wrong_project_key"
}

const json = { "content-type": "application/json" }

async function call(path: string, init: RequestInit & { body?: string }, fallback: string): Promise<Response> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: init.body !== undefined ? json : undefined,
  })
  if (!response.ok) await fail(response, fallback)
  return response
}

const base = (hash: string) => `/api/projects/${hash}/env`

export async function listEnvVars(hash: string): Promise<EnvList> {
  const response = await call(base(hash), {}, "Could not load the environment variables.")
  return (await response.json()) as EnvList
}

export async function projectKeyStatus(hash: string): Promise<ProjectKeyStatus> {
  const response = await call(`${base(hash)}/project-key`, {}, "Could not read the project key's status.")
  return (await response.json()) as ProjectKeyStatus
}

/** Sets the project key up; `migrated` older saved keys were moved into `.agent/env.val`. */
export async function setupProjectKey(hash: string, projectKey: string): Promise<{ migrated: number; skipped: number }> {
  const response = await call(
    `${base(hash)}/project-key`,
    { method: "POST", body: JSON.stringify({ projectKey }) },
    "Could not set the project key up.",
  )
  return (await response.json()) as { migrated: number; skipped: number }
}

export async function changeProjectKey(hash: string, oldKey: string, newKey: string): Promise<void> {
  await call(`${base(hash)}/project-key`, { method: "PUT", body: JSON.stringify({ oldKey, newKey }) }, "Could not change the project key.")
}

/** Removes `.agent/env.val` and every value in it: the way back from a forgotten key. */
export async function resetProjectKey(hash: string): Promise<void> {
  await call(`${base(hash)}/project-key`, { method: "DELETE" }, "Could not reset the project key.")
}

/** Resolves when `projectKey` is the project's; throws an `EnvApiError` otherwise. */
export async function unlockEnv(hash: string, projectKey: string): Promise<void> {
  await call(`${base(hash)}/unlock`, { method: "POST", body: JSON.stringify({ projectKey }) }, "Could not unlock.")
}

export async function createEnvVar(hash: string, projectKey: string, input: EnvVarInput): Promise<EnvVar> {
  const response = await call(
    `${base(hash)}/vars`,
    { method: "POST", body: JSON.stringify({ projectKey, ...input }) },
    "Could not save the variable.",
  )
  return ((await response.json()) as { var: EnvVar }).var
}

export async function updateEnvVar(hash: string, projectKey: string, id: string, patch: EnvVarPatch): Promise<EnvVar> {
  const response = await call(
    `${base(hash)}/vars/${id}`,
    { method: "PATCH", body: JSON.stringify({ projectKey, ...patch }) },
    "Could not save the variable.",
  )
  return ((await response.json()) as { var: EnvVar }).var
}

export async function deleteEnvVar(hash: string, projectKey: string, id: string): Promise<void> {
  await call(`${base(hash)}/vars/${id}`, { method: "DELETE", body: JSON.stringify({ projectKey }) }, "Could not remove the variable.")
}

export async function revealEnvVar(hash: string, projectKey: string, id: string): Promise<string> {
  const response = await call(
    `${base(hash)}/vars/${id}/reveal`,
    { method: "POST", body: JSON.stringify({ projectKey }) },
    "Could not read the variable.",
  )
  return ((await response.json()) as { value: string }).value
}

/** "openai, prod , billing" -> ["openai", "prod", "billing"], blanks and repeats dropped. */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))]
}
