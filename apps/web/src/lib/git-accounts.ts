import type { GitProvider } from "@ucch/protocol"

/**
 * The person's connected git accounts (Settings -> Git Provider).
 * A token never comes back to the browser: the list carries its prefix and
 * last four, nothing more.
 */

export interface GitAccountMeta {
  id: string
  provider: GitProvider
  name: string
  baseUrl: string
  login: string | null
  prefix: string
  last4: string
  scopes: string | null
  createdAt: string
  lastUsedAt: string | null
}

export interface GitAccountsResponse {
  accounts: GitAccountMeta[]
  encryptionAvailable: boolean
  /** A GitHub sign-in's token is standing in, as no GitHub account is saved. */
  githubFromLogin: boolean
}

export const MAX_NAME_LENGTH = 40

/** Where "connect one in Settings" goes. */
export const GIT_PROVIDER_HREF = "/setting/git-provider"

const PATH = "/api/account/git-accounts"
const NO_STORE: RequestInit = { credentials: "include", cache: "no-store" }

async function call<T>(path: string, method?: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    ...NO_STORE,
    ...(method ? { method } : {}),
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  })
  const answer = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(answer.error ?? `Request failed (${response.status}).`)
  return answer
}

export const fetchGitAccountSettings = () => call<GitAccountsResponse>(PATH)

export async function createGitAccount(input: {
  provider: GitProvider
  name: string
  baseUrl?: string
  token: string
}): Promise<GitAccountMeta> {
  return (await call<{ account: GitAccountMeta }>(PATH, "POST", input)).account
}

export async function updateGitAccount(id: string, change: { name: string } | { token: string }): Promise<GitAccountMeta> {
  return (await call<{ account: GitAccountMeta }>(`${PATH}/${id}`, "PATCH", change)).account
}

export async function removeGitAccount(id: string): Promise<void> {
  await call(`${PATH}/${id}`, "DELETE")
}
