/**
 * The account's named model-provider keys (Settings -> AI Provider -> Custom),
 * and how a model picked under one is named.
 *
 * A named key never comes back to the browser: the list carries its prefix
 * and last four, nothing more.
 */

export type ModelKeyKind = "openrouter" | "anonrouter"

export interface ModelKeyMeta {
  id: string
  kind: ModelKeyKind
  name: string
  prefix: string
  last4: string
  /** The OpenRouter key voice input, research, OMP and the other general uses bill. */
  isDefault: boolean
  createdAt: string
  lastUsedAt: string | null
}

export const MODEL_KEY_KINDS: { id: ModelKeyKind; name: string; placeholder: string; keysUrl: string; keysLabel: string }[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    placeholder: "sk-or-v1-…",
    keysUrl: "https://openrouter.ai/keys",
    keysLabel: "openrouter.ai/keys",
  },
  {
    id: "anonrouter",
    name: "AnonRouter",
    placeholder: "ar_…",
    keysUrl: "https://docs.anonrouter.ai/authentication",
    keysLabel: "the AnonRouter dashboard",
  },
]

export const KIND_NAMES: Record<ModelKeyKind, string> = { openrouter: "OpenRouter", anonrouter: "AnonRouter" }

export const MAX_NAME_LENGTH = 40

/** A model id that names a key: `@<keyId>/<model>`, as the server reads it. */
const KEYED = /^@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(.+)$/i

export function parseKeyedModel(model: string): { keyId: string; model: string } | null {
  const match = KEYED.exec(model)
  return match ? { keyId: match[1]!.toLowerCase(), model: match[2]! } : null
}

export function keyedModel(keyId: string, model: string): string {
  return `@${keyId}/${model}`
}

/** The model id without the key it was picked under, for display. */
export function bareModelId(model: string): string {
  return parseKeyedModel(model)?.model ?? model
}

const NO_STORE: RequestInit = { credentials: "include", cache: "no-store" }

async function failure(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: string }
    return new Error(body.error ?? `Request failed (${response.status}).`)
  } catch {
    return new Error(`Request failed (${response.status}).`)
  }
}

export async function fetchModelKeys(): Promise<{ keys: ModelKeyMeta[]; encryptionAvailable: boolean }> {
  const response = await fetch("/api/account/model-keys", NO_STORE)
  if (!response.ok) throw await failure(response)
  return (await response.json()) as { keys: ModelKeyMeta[]; encryptionAvailable: boolean }
}

export async function createModelKey(input: { kind: ModelKeyKind; name: string; key: string }): Promise<ModelKeyMeta> {
  const response = await fetch("/api/account/model-keys", {
    ...NO_STORE,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { key: ModelKeyMeta }).key
}

export async function renameModelKey(id: string, name: string): Promise<ModelKeyMeta> {
  const response = await fetch(`/api/account/model-keys/${id}`, {
    ...NO_STORE,
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { key: ModelKeyMeta }).key
}

export async function makeDefaultModelKey(id: string): Promise<ModelKeyMeta> {
  const response = await fetch(`/api/account/model-keys/${id}/default`, { ...NO_STORE, method: "POST" })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { key: ModelKeyMeta }).key
}

export async function removeModelKey(id: string): Promise<void> {
  const response = await fetch(`/api/account/model-keys/${id}`, { ...NO_STORE, method: "DELETE" })
  if (!response.ok) throw await failure(response)
}
