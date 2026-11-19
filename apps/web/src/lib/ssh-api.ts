/**
 * The Terminal section over the API: a workspace's SSH hosts, the shells
 * opened on them, their files over SFTP, and the agent that works on them.
 *
 * Same shape as `resources-api.ts`: a thrown `Error` carries the server's
 * own sentence. Credentials go up once, when a host is saved or changed, and
 * never come back down.
 */

import type {
  DomainEvent,
  RemoteChatPermissionReply,
  RemoteChatSend,
  RemoteEntry,
  SshHostCreate,
  SshHostSummary,
  SshHostUpdate,
} from "@ucch/protocol"

/** A refusal from the server: the sentence, the status, and its code when it gave one. */
export class SshApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message)
  }
}

async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers:
      init.body && typeof init.body === "string" ? { "content-type": "application/json", ...init.headers } : init.headers,
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string } & Record<string, unknown>
    throw new SshApiError(body.error ?? fallback, response.status, body.code, body)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const json = (body: unknown) => JSON.stringify(body)
const host = (id: string) => `/api/ssh-hosts/${encodeURIComponent(id)}`
const query = (params: Record<string, string>) => new URLSearchParams(params).toString()

// --- hosts -------------------------------------------------------------------

export async function fetchSshHosts(workspaceId: string): Promise<SshHostSummary[]> {
  const result = await call<{ hosts: SshHostSummary[] }>(
    `/api/workspaces/${workspaceId}/ssh-hosts`,
    {},
    "Could not list the servers.",
  )
  return result.hosts
}

export async function createSshHost(workspaceId: string, input: SshHostCreate): Promise<SshHostSummary> {
  const result = await call<{ host: SshHostSummary }>(
    `/api/workspaces/${workspaceId}/ssh-hosts`,
    { method: "POST", body: json(input) },
    "Could not add the server.",
  )
  return result.host
}

export async function updateSshHost(id: string, input: SshHostUpdate): Promise<SshHostSummary> {
  const result = await call<{ host: SshHostSummary }>(host(id), { method: "PATCH", body: json(input) }, "Could not save the server.")
  return result.host
}

export async function retrustSshHost(id: string): Promise<SshHostSummary> {
  const result = await call<{ host: SshHostSummary }>(`${host(id)}/retrust`, { method: "POST" }, "Could not re-trust the server.")
  return result.host
}

export async function deleteSshHost(id: string): Promise<void> {
  await call<void>(host(id), { method: "DELETE" }, "Could not remove the server.")
}

// --- terminals ---------------------------------------------------------------

/** Starts a shell under an id the caller is already watching. */
export async function openSshTerminal(id: string, terminalId: string, cols: number, rows: number): Promise<void> {
  await call<void>(
    `${host(id)}/terminals`,
    { method: "POST", body: json({ terminalId, cols, rows }) },
    "Could not open a terminal on the server.",
  )
}

// --- files -------------------------------------------------------------------

export interface RemoteListing {
  path: string
  home: string
  entries: RemoteEntry[]
  truncated: boolean
}

/** One folder; an empty path is the login's home. */
export function listRemoteFolder(id: string, path: string): Promise<RemoteListing> {
  return call<RemoteListing>(`${host(id)}/files?${query({ path })}`, {}, "Could not read the folder.")
}

export function remoteFileUrl(id: string, path: string, download = false): string {
  return `${host(id)}/files/content?${query({ path, ...(download ? { download: "1" } : {}) })}`
}

export function readRemoteText(id: string, path: string): Promise<{ path: string; content: string; version: string }> {
  return call(`${host(id)}/files/text?${query({ path })}`, {}, "Could not open the file.")
}

export function writeRemoteText(
  id: string,
  path: string,
  content: string,
  ifVersion?: string,
): Promise<{ path: string; version: string }> {
  return call(
    `${host(id)}/files/text`,
    { method: "PUT", body: json({ path, content, ...(ifVersion ? { ifVersion } : {}) }) },
    "Could not save the file.",
  )
}

export async function uploadRemoteFile(id: string, path: string, file: Blob, overwrite = false): Promise<void> {
  await call<void>(
    `${host(id)}/files?${query({ path, ...(overwrite ? { overwrite: "1" } : {}) })}`,
    { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } },
    "Could not upload the file.",
  )
}

export async function createRemoteFolder(id: string, path: string): Promise<void> {
  await call<void>(`${host(id)}/files/folder`, { method: "POST", body: json({ path }) }, "Could not create the folder.")
}

export async function moveRemoteEntry(id: string, from: string, to: string): Promise<void> {
  await call<void>(`${host(id)}/files/move`, { method: "PATCH", body: json({ from, to }) }, "Could not rename it.")
}

export async function deleteRemoteEntry(id: string, path: string): Promise<void> {
  await call<void>(`${host(id)}/files?${query({ path })}`, { method: "DELETE" }, "Could not delete it.")
}

// --- the agent ---------------------------------------------------------------

export async function sendRemoteChat(id: string, body: RemoteChatSend): Promise<void> {
  await call<void>(`${host(id)}/chat`, { method: "POST", body: json(body) }, "Could not send the message.")
}

export function fetchRemoteChat(
  chatId: string,
): Promise<{ hostId: string; events: DomainEvent[]; running: boolean }> {
  return call(`/api/remote-chats/${chatId}`, {}, "Could not load the conversation.")
}

export async function replyRemoteChat(chatId: string, body: RemoteChatPermissionReply): Promise<void> {
  await call<void>(`/api/remote-chats/${chatId}/permission`, { method: "POST", body: json(body) }, "Could not answer.")
}

export async function stopRemoteChat(chatId: string): Promise<void> {
  await call<void>(`/api/remote-chats/${chatId}/stop`, { method: "POST" }, "Could not stop the agent.")
}
