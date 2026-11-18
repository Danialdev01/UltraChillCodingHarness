/**
 * A workspace's knowledge bases, over the API: the bases, their documents,
 * each base's graph, and a search over it.
 *
 * Same shape as `resources-api.ts`: a thrown `Error` carries the server's own
 * sentence.
 */

import { useQuery } from "@tanstack/react-query"
import { KNOWLEDGE_UPLOAD_CHUNK_BYTES, MAX_KNOWLEDGE_DOCUMENT_BYTES } from "@ucch/protocol/plain"
import type {
  KnowledgeBaseCreate,
  KnowledgeBaseSummary,
  KnowledgeBaseUpdate,
  KnowledgeDocumentSummary,
  KnowledgeGraph,
  KnowledgeHit,
  KnowledgeScope,
} from "@ucch/protocol"

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
  if (response.status === 204 || response.status === 202) return undefined as T
  return (await response.json()) as T
}

const bases = (workspaceId: string) => `/api/workspaces/${workspaceId}/knowledge`
const base = (workspaceId: string, baseId: string) => `${bases(workspaceId)}/${encodeURIComponent(baseId)}`

/** The query keys the views read through, so a change can invalidate exactly them. */
export const knowledgeKeys = {
  all: (workspaceId: string) => ["knowledge", workspaceId] as const,
  bases: (workspaceId: string) => ["knowledge", workspaceId, "bases"] as const,
  base: (workspaceId: string, baseId: string) => ["knowledge", workspaceId, "base", baseId] as const,
  documents: (workspaceId: string, baseId: string) => ["knowledge", workspaceId, "base", baseId, "documents"] as const,
  graph: (workspaceId: string, baseId: string) => ["knowledge", workspaceId, "base", baseId, "graph"] as const,
  search: (workspaceId: string, baseId: string, q: string) => ["knowledge", workspaceId, "base", baseId, "search", q] as const,
}

export async function fetchKnowledgeBases(workspaceId: string): Promise<KnowledgeBaseSummary[]> {
  return (await call<{ bases: KnowledgeBaseSummary[] }>(bases(workspaceId), {}, "Could not list the knowledge bases.")).bases
}

/** The workspace's knowledge bases, read through the one query every view shares. */
export function useKnowledgeBases(workspaceId: string) {
  return useQuery({
    queryKey: knowledgeKeys.bases(workspaceId),
    queryFn: () => fetchKnowledgeBases(workspaceId),
    enabled: workspaceId !== "",
  })
}

export async function fetchKnowledgeBase(workspaceId: string, baseId: string): Promise<KnowledgeBaseSummary> {
  return (await call<{ base: KnowledgeBaseSummary }>(base(workspaceId, baseId), {}, "Could not load the knowledge base.")).base
}

export async function createKnowledgeBase(workspaceId: string, input: KnowledgeBaseCreate): Promise<KnowledgeBaseSummary> {
  return (
    await call<{ base: KnowledgeBaseSummary }>(
      bases(workspaceId),
      { method: "POST", body: JSON.stringify(input) },
      "Could not create the knowledge base.",
    )
  ).base
}

export async function updateKnowledgeBase(
  workspaceId: string,
  baseId: string,
  input: KnowledgeBaseUpdate,
): Promise<KnowledgeBaseSummary> {
  return (
    await call<{ base: KnowledgeBaseSummary }>(
      base(workspaceId, baseId),
      { method: "PATCH", body: JSON.stringify(input) },
      "Could not save the knowledge base.",
    )
  ).base
}

export async function deleteKnowledgeBase(workspaceId: string, baseId: string): Promise<void> {
  await call<void>(base(workspaceId, baseId), { method: "DELETE" }, "Could not delete the knowledge base.")
}

export async function fetchKnowledgeDocuments(workspaceId: string, baseId: string): Promise<KnowledgeDocumentSummary[]> {
  return (
    await call<{ documents: KnowledgeDocumentSummary[] }>(
      `${base(workspaceId, baseId)}/documents`,
      {},
      "Could not list the documents.",
    )
  ).documents
}

/** How many times one chunk is tried before the upload gives up. */
const CHUNK_TRIES = 4

/**
 * Uploads a document in `KNOWLEDGE_UPLOAD_CHUNK_BYTES` pieces, up to
 * `MAX_KNOWLEDGE_DOCUMENT_BYTES` (2.5 GB). One request per piece keeps every
 * request small, so neither the `/api` proxy nor the server holds the whole
 * file. A piece that fails is retried; one the server already has (its answer
 * was lost) is skipped. `onProgress` is told the bytes sent so far.
 */
export async function uploadKnowledgeDocument(
  workspaceId: string,
  baseId: string,
  file: File,
  onProgress?: (sent: number) => void,
): Promise<KnowledgeDocumentSummary> {
  if (file.size === 0) throw new Error(`${file.name} is empty.`)
  if (file.size > MAX_KNOWLEDGE_DOCUMENT_BYTES) {
    throw new Error(`${file.name} is over 2.5 GB, the most one document can be.`)
  }
  const uploads = `${base(workspaceId, baseId)}/uploads`
  const { uploadId, chunkBytes } = await call<{ uploadId: string; chunkBytes: number }>(
    uploads,
    {
      method: "POST",
      body: JSON.stringify({ name: file.name, type: file.type || "application/octet-stream", size: file.size }),
    },
    `Could not start uploading ${file.name}.`,
  )
  const piece = chunkBytes > 0 ? Math.min(chunkBytes, KNOWLEDGE_UPLOAD_CHUNK_BYTES) : KNOWLEDGE_UPLOAD_CHUNK_BYTES
  const at = `${uploads}/${encodeURIComponent(uploadId)}`
  try {
    let offset = 0
    while (offset < file.size) {
      offset = await sendChunk(at, file, offset, piece)
      onProgress?.(offset)
    }
    return (
      await call<{ document: KnowledgeDocumentSummary }>(
        `${at}/complete`,
        { method: "POST" },
        `Could not finish uploading ${file.name}.`,
      )
    ).document
  } catch (error) {
    void fetch(at, { method: "DELETE", credentials: "include" }).catch(() => {})
    throw error
  }
}

/** Sends the piece at `offset`, retrying; resolves to where the next one starts. */
async function sendChunk(at: string, file: File, offset: number, piece: number): Promise<number> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < CHUNK_TRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    try {
      const response = await fetch(`${at}?offset=${offset}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/octet-stream" },
        body: file.slice(offset, offset + piece),
      })
      const body = (await response.json().catch(() => ({}))) as { received?: number; error?: string }
      if (response.ok && typeof body.received === "number") return body.received
      // The server already has more than we thought (a lost answer): go on from there.
      if (response.status === 409 && typeof body.received === "number" && body.received >= offset) return body.received
      if (response.status === 404 || response.status === 413) throw new FatalUpload(body.error ?? `Upload of ${file.name} failed.`)
      lastError = new Error(body.error ?? `Upload of ${file.name} failed (${response.status}).`)
    } catch (error) {
      if (error instanceof FatalUpload) throw error
      lastError = error
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Upload of ${file.name} stopped at ${Math.round((offset / file.size) * 100)}%: ${reason}`)
}

class FatalUpload extends Error {}

export async function deleteKnowledgeDocument(workspaceId: string, baseId: string, documentId: string): Promise<void> {
  await call<void>(
    `${base(workspaceId, baseId)}/documents/${encodeURIComponent(documentId)}`,
    { method: "DELETE" },
    "Could not delete the document.",
  )
}

export async function rebuildKnowledgeGraph(workspaceId: string, baseId: string, documentId: string): Promise<void> {
  await call<void>(
    `${base(workspaceId, baseId)}/documents/${encodeURIComponent(documentId)}/rebuild`,
    { method: "POST" },
    "Could not rebuild the graph.",
  )
}

export function knowledgeDocumentUrl(workspaceId: string, baseId: string, documentId: string): string {
  return `${base(workspaceId, baseId)}/documents/${encodeURIComponent(documentId)}/content`
}

export async function fetchKnowledgeGraph(workspaceId: string, baseId: string): Promise<KnowledgeGraph> {
  return (await call<{ graph: KnowledgeGraph }>(`${base(workspaceId, baseId)}/graph`, {}, "Could not load the graph.")).graph
}

export async function searchKnowledge(workspaceId: string, baseId: string, q: string): Promise<KnowledgeHit[]> {
  return (
    await call<{ hits: KnowledgeHit[] }>(
      `${base(workspaceId, baseId)}/search?${new URLSearchParams({ q })}`,
      {},
      "Could not search the knowledge base.",
    )
  ).hits
}

/** The documents a base is still reading: a list holding one is polled until it settles. */
export function anyProcessing(documents: readonly KnowledgeDocumentSummary[] | undefined): boolean {
  return Boolean(documents?.some((d) => d.status === "processing"))
}

// --- The chat's pick --------------------------------------------------------

/**
 * Where a chat's agent looks: the web alone (the default, and an ordinary
 * turn), its knowledge bases and the web, or its knowledge bases alone.
 */
export type KnowledgeMode = "web" | "knowledge_web" | "knowledge"

export const KNOWLEDGE_MODES: readonly KnowledgeMode[] = ["web", "knowledge_web", "knowledge"]

/** What a chat answers from: the mode, and the bases picked for it. */
export interface KnowledgeChoice {
  mode: KnowledgeMode
  baseIds: string[]
}

export const NO_KNOWLEDGE: KnowledgeChoice = { mode: "web", baseIds: [] }

/** The most bases one message carries (`MAX_MESSAGE_KNOWLEDGE_BASES` on the server). */
export const MAX_KNOWLEDGE_PICK = 8

/**
 * What `thread.send` carries for a pick, or undefined for an ordinary turn:
 * Web only, or a knowledge mode with no base picked yet.
 */
export function toMessageKnowledge(choice: KnowledgeChoice): { baseIds: string[]; scope: KnowledgeScope } | undefined {
  if (choice.mode === "web" || choice.baseIds.length === 0) return undefined
  return {
    baseIds: choice.baseIds.slice(0, MAX_KNOWLEDGE_PICK),
    scope: choice.mode === "knowledge" ? "knowledge" : "web",
  }
}

const choiceKey = (scopeKey: string) => `ucch:knowledge-choice:${scopeKey}`

/**
 * The pick for a chat, remembered in this browser per chat. A per-viewer
 * convenience, so browser storage; it never throws. Anything unreadable --
 * or written by an older version, with no mode -- is Web only.
 */
export function readKnowledgeChoice(scopeKey: string): KnowledgeChoice | null {
  try {
    const raw = window.localStorage.getItem(choiceKey(scopeKey))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<KnowledgeChoice>
    const baseIds = Array.isArray(parsed.baseIds) ? parsed.baseIds.filter((id): id is string => typeof id === "string") : []
    const mode = KNOWLEDGE_MODES.includes(parsed.mode as KnowledgeMode) ? (parsed.mode as KnowledgeMode) : "web"
    return { mode, baseIds }
  } catch {
    return null
  }
}

export function writeKnowledgeChoice(scopeKey: string, choice: KnowledgeChoice): void {
  try {
    window.localStorage.setItem(choiceKey(scopeKey), JSON.stringify(choice))
  } catch {
    // Private mode or storage full: the pick just is not remembered.
  }
}

export const sessionChoiceKey = (chatKey: string) => `session:${chatKey}`
