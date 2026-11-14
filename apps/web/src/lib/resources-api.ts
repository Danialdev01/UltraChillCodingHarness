/**
 * The workspace's Resources, over the API: its stores, the files in each, and
 * copying one into a project -- into the chat as an attachment, or into the
 * file tree.
 *
 * Same shape as `database-api.ts`: a thrown `Error` carries the server's own
 * sentence.
 */

import type {
  ResourceDragPayload,
  ResourceEntry,
  ResourceStoreSummary,
  S3StoreCreate,
  S3StoreUpdate,
} from "@ucch/protocol"
import { RESOURCE_DRAG_TYPE, mediaTypeFor } from "@ucch/protocol/plain"

import { projectApiUrl, type ProjectTarget } from "./project-target"

export { RESOURCE_DRAG_TYPE, type ResourceDragPayload }

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  throw new Error(body.error ?? fallback)
}

async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers:
      init.body && typeof init.body === "string" ? { "content-type": "application/json", ...init.headers } : init.headers,
  })
  if (!response.ok) await fail(response, fallback)
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const json = (body: unknown) => JSON.stringify(body)
const base = (workspaceId: string) => `/api/workspaces/${workspaceId}`
const files = (workspaceId: string, storeId: string) =>
  `${base(workspaceId)}/resources/${encodeURIComponent(storeId)}`

/** The query keys the panel reads through, so a change can invalidate exactly them. */
export const resourceKeys = {
  stores: (workspaceId: string) => ["resources", workspaceId, "stores"] as const,
  folder: (workspaceId: string, storeId: string, prefix: string) =>
    ["resources", workspaceId, "folder", storeId, prefix] as const,
  store: (workspaceId: string, storeId: string) => ["resources", workspaceId, "folder", storeId] as const,
}

// --- stores ------------------------------------------------------------------

export async function fetchStores(workspaceId: string): Promise<ResourceStoreSummary[]> {
  const result = await call<{ stores: ResourceStoreSummary[] }>(
    `${base(workspaceId)}/resource-stores`,
    {},
    "Could not list the storage.",
  )
  return result.stores
}

export async function createS3Store(workspaceId: string, input: S3StoreCreate): Promise<ResourceStoreSummary> {
  const result = await call<{ store: ResourceStoreSummary }>(
    `${base(workspaceId)}/resource-stores`,
    { method: "POST", body: json(input) },
    "Could not add the bucket.",
  )
  return result.store
}

export async function updateS3Store(
  workspaceId: string,
  storeId: string,
  input: S3StoreUpdate,
): Promise<ResourceStoreSummary> {
  const result = await call<{ store: ResourceStoreSummary }>(
    `${base(workspaceId)}/resource-stores/${encodeURIComponent(storeId)}`,
    { method: "PATCH", body: json(input) },
    "Could not save the bucket.",
  )
  return result.store
}

export async function removeStore(workspaceId: string, storeId: string): Promise<void> {
  await call<void>(
    `${base(workspaceId)}/resource-stores/${encodeURIComponent(storeId)}`,
    { method: "DELETE" },
    "Could not remove the storage.",
  )
}

// --- files -------------------------------------------------------------------

export async function listFolder(workspaceId: string, storeId: string, prefix: string): Promise<ResourceEntry[]> {
  const query = prefix ? `?${new URLSearchParams({ prefix })}` : ""
  const result = await call<{ entries: ResourceEntry[] }>(
    `${files(workspaceId, storeId)}${query}`,
    {},
    "Could not list the folder.",
  )
  return result.entries
}

/** Where a file's bytes are: inline for a preview, or as a download. */
export function resourceContentUrl(
  workspaceId: string,
  storeId: string,
  key: string,
  options: { download?: boolean } = {},
): string {
  const query = new URLSearchParams({ key })
  if (options.download) query.set("download", "1")
  return `${files(workspaceId, storeId)}/content?${query}`
}

/** Uploads one file as raw bytes, the way chat attachments are sent. */
export async function uploadResource(workspaceId: string, storeId: string, key: string, file: File): Promise<void> {
  const query = new URLSearchParams({ key, type: file.type || "" })
  const response = await fetch(`${files(workspaceId, storeId)}?${query}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  })
  if (!response.ok) await fail(response, `Could not upload ${file.name}.`)
}

export async function createResourceFolder(workspaceId: string, storeId: string, key: string): Promise<void> {
  await call<void>(
    `${files(workspaceId, storeId)}/folder`,
    { method: "POST", body: json({ key }) },
    "Could not create the folder.",
  )
}

export async function moveResource(workspaceId: string, storeId: string, from: string, to: string): Promise<void> {
  await call<void>(
    `${files(workspaceId, storeId)}/move`,
    { method: "PATCH", body: json({ from, to }) },
    "Could not move it.",
  )
}

export async function deleteResource(workspaceId: string, storeId: string, key: string): Promise<void> {
  await call<void>(
    `${files(workspaceId, storeId)}?${new URLSearchParams({ key })}`,
    { method: "DELETE" },
    "Could not delete it.",
  )
}

// --- into a project ----------------------------------------------------------

/**
 * A Resources file as a `File`, for the chat: dropping one on the composer
 * attaches it exactly as a file from the desktop would be -- staged, its text
 * inlined when small, a picture shown to the model -- because it then goes
 * through the same path.
 */
export async function resourceAsFile(payload: ResourceDragPayload): Promise<File> {
  const response = await fetch(
    resourceContentUrl(payload.workspaceId, payload.storeId, payload.key, { download: true }),
    { credentials: "include" },
  )
  if (!response.ok) await fail(response, `Could not read ${payload.name}.`)
  const blob = await response.blob()
  // The download is always octet-stream; the name says what it is. Empty lets
  // the attachment code read the extension, as it does for desktop files.
  return new File([blob], payload.name, { type: mediaTypeFor(payload.name) ?? "" })
}

/** A Resources file or folder copied into the project's tree, under `dir` ("" is the root). */
export async function copyResourceIntoProject(
  target: ProjectTarget,
  payload: ResourceDragPayload,
  dir: string,
): Promise<{ path: string; files: number }> {
  return call<{ path: string; files: number }>(
    projectApiUrl(target, "file/from-resource"),
    {
      method: "POST",
      body: json({ workspaceId: payload.workspaceId, storeId: payload.storeId, key: payload.key, dir }),
    },
    `Could not copy ${payload.name} into the project.`,
  )
}

// --- dragging ----------------------------------------------------------------

/** Whether a drag carries a Resources row. Readable during dragover, unlike the data itself. */
export function carriesResource(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes(RESOURCE_DRAG_TYPE)
}

/** The dragged resource on drop, or null when the data is missing or not ours. */
export function readResourceDrag(dataTransfer: Pick<DataTransfer, "getData">): ResourceDragPayload | null {
  const raw = dataTransfer.getData(RESOURCE_DRAG_TYPE)
  if (!raw) return null
  try {
    return parseResourceDrag(JSON.parse(raw))
  } catch {
    return null
  }
}

/**
 * A drag payload, checked by hand rather than with the protocol's schema:
 * the browser imports no zod (see `protocol-imports.test.ts`).
 */
export function parseResourceDrag(value: unknown): ResourceDragPayload | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  const str = (x: unknown) => typeof x === "string" && x.length > 0
  if (!str(v.workspaceId) || !str(v.storeId) || !str(v.key) || !str(v.name)) return null
  if (v.kind !== "file" && v.kind !== "folder") return null
  return {
    workspaceId: v.workspaceId as string,
    storeId: v.storeId as string,
    key: v.key as string,
    name: v.name as string,
    kind: v.kind,
  }
}

/** Puts a resource on a drag: ours for the app, a URL for anywhere else. */
export function writeResourceDrag(dataTransfer: DataTransfer, payload: ResourceDragPayload): void {
  dataTransfer.setData(RESOURCE_DRAG_TYPE, JSON.stringify(payload))
  if (payload.kind === "file") {
    const url = new URL(
      resourceContentUrl(payload.workspaceId, payload.storeId, payload.key, { download: true }),
      window.location.origin,
    ).toString()
    dataTransfer.setData("text/uri-list", url)
  }
  dataTransfer.setData("text/plain", payload.name)
  dataTransfer.effectAllowed = "copy"
}
