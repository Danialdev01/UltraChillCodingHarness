import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { knowledgeBases, knowledgeDocuments, type Database, type KnowledgeDocumentGraph, type KnowledgeDocumentRow } from "@ucch/db";
import type {
  KnowledgeBaseCreate,
  KnowledgeBaseSummary,
  KnowledgeBaseUpdate,
  KnowledgeDocumentSummary,
  KnowledgeGraph,
  KnowledgeHit,
  MessageKnowledge,
} from "@ucch/protocol";
import type { Complete } from "@ucch/agent";
import { extractDocument, looksLikeText } from "./extract.js";
import {
  GRAPH_PROMPT,
  graphUserMessage,
  GRAPH_SAMPLE_CHARS,
  chunkText,
  cleanGraph,
  heuristicGraph,
  knowledgePrompt,
  mergeGraphs,
  parseGraphJson,
  rankChunks,
  relevantFacts,
  safeFileName,
  type Chunk,
} from "./knowledge-graph.js";

/** The most text kept from one document. */
const MAX_DOC_CHARS = 2_000_000;

/**
 * A document up to this size is read whole to pull its text out. Past it
 * (up to `MAX_KNOWLEDGE_DOCUMENT_BYTES`) only a plain-text file is read, and
 * only its start: enough bytes for `MAX_DOC_CHARS`, which is all that is kept.
 */
const READ_WHOLE_MAX_BYTES = 512 * 1024 * 1024;
const TEXT_HEAD_BYTES = 8 * 1024 * 1024;

/** "2.34 GB", "600 MB": sizes in the sentences a document shows. */
function humanSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Formats whose text needs the whole file: a cut-off start of one reads as nothing. */
const WHOLE_FILE_EXTS = new Set([
  "pdf", "docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "potx", "odt", "ott", "ods", "odp",
  "epub", "doc", "xls", "ppt", "pages", "key", "numbers", "zip", "tar", "tgz", "gz", "ipynb",
]);

/** An upload left unfinished this long is dropped, with its partial file. */
const UPLOAD_IDLE_MS = 60 * 60 * 1000;

interface PendingUpload {
  workspaceId: string;
  baseId: string;
  userId: string;
  name: string;
  mediaType: string;
  size: number;
  received: number;
  path: string;
  touched: number;
  /** The chunk being written, so two never append at once. */
  busy: boolean;
}

/** Why a chunk or a finish was refused: the route turns each into a status. */
export type UploadRefusal =
  | { refused: "not_found" }
  | { refused: "offset"; received: number }
  | { refused: "too_big" }
  | { refused: "incomplete"; received: number }
  | { refused: "busy" };
/** Passages put in front of a turn. */
const TURN_HITS = 12;

export class KnowledgeError extends Error {}

export interface GraphModel {
  complete: Complete;
  model: string;
  /** The uploader's OpenRouter key, or null to use the local fallback. */
  apiKeyFor(userId: string): Promise<string | null>;
}

export interface KnowledgeServiceOptions {
  db: Database;
  /** `WORKSPACE_ROOT`: originals, and each base's text, live under its `.knowledge/`. */
  workspaceRoot: string;
  graphModel?: GraphModel;
  onError?: (error: unknown) => void;
}

/** What a knowledge turn adds: the prompt, and the bases' folders to place in the tree. */
export interface TurnKnowledge {
  prompt: string;
  scope: MessageKnowledge["scope"];
  baseNames: string[];
  hits: number;
  /** The bases' text folders, outside the project: the agent reads them there. */
  dirs: string[];
}

/**
 * A workspace's knowledge bases: the folders, the documents in each (the
 * original on disk, the text and its graph slice in Postgres), and the
 * search a chat turn runs over them.
 */
export class KnowledgeService {
  readonly #db: Database;
  readonly #root: string;
  readonly #graphModel: GraphModel | undefined;
  readonly #onError: (error: unknown) => void;
  readonly #uploads = new Map<string, PendingUpload>();
  #sweptStale = false;

  constructor(options: KnowledgeServiceOptions) {
    this.#db = options.db;
    this.#root = resolve(options.workspaceRoot, ".knowledge");
    this.#graphModel = options.graphModel;
    this.#onError = options.onError ?? (() => {});
  }

  #originalPath(baseId: string, documentId: string): string {
    return join(this.#root, baseId, documentId);
  }

  // ---- Bases -----------------------------------------------------------------

  async list(workspaceId: string): Promise<KnowledgeBaseSummary[]> {
    const bases = await this.#db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.workspaceId, workspaceId))
      .orderBy(asc(knowledgeBases.name));
    if (bases.length === 0) return [];
    const docs = await this.#db
      .select({ baseId: knowledgeDocuments.baseId, id: knowledgeDocuments.id, size: knowledgeDocuments.size, graph: knowledgeDocuments.graph })
      .from(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.baseId, bases.map((b) => b.id)));
    return bases.map((base) => {
      const mine = docs.filter((d) => d.baseId === base.id);
      const graph = mergeGraphs(mine);
      return {
        id: base.id,
        workspaceId: base.workspaceId,
        name: base.name,
        description: base.description,
        documentCount: mine.length,
        totalBytes: mine.reduce((n, d) => n + d.size, 0),
        entityCount: graph.nodes.length,
        relationCount: graph.edges.length,
        createdAt: base.createdAt.toISOString(),
        updatedAt: base.updatedAt.toISOString(),
      };
    });
  }

  async get(workspaceId: string, baseId: string): Promise<KnowledgeBaseSummary | null> {
    return (await this.list(workspaceId)).find((b) => b.id === baseId) ?? null;
  }

  async create(workspaceId: string, userId: string, input: KnowledgeBaseCreate): Promise<KnowledgeBaseSummary> {
    const [row] = await this.#db
      .insert(knowledgeBases)
      .values({ workspaceId, name: input.name, description: input.description ?? "", createdBy: userId })
      .returning();
    return (await this.get(workspaceId, row!.id))!;
  }

  async update(workspaceId: string, baseId: string, input: KnowledgeBaseUpdate): Promise<KnowledgeBaseSummary | null> {
    const rows = await this.#db
      .update(knowledgeBases)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(knowledgeBases.id, baseId), eq(knowledgeBases.workspaceId, workspaceId)))
      .returning({ id: knowledgeBases.id });
    return rows.length ? this.get(workspaceId, baseId) : null;
  }

  async remove(workspaceId: string, baseId: string): Promise<boolean> {
    const rows = await this.#db
      .delete(knowledgeBases)
      .where(and(eq(knowledgeBases.id, baseId), eq(knowledgeBases.workspaceId, workspaceId)))
      .returning({ id: knowledgeBases.id });
    if (rows.length === 0) return false;
    await rm(join(this.#root, baseId), { recursive: true, force: true }).catch(this.#onError);
    return true;
  }

  async #owns(workspaceId: string, baseId: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ id: knowledgeBases.id })
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.id, baseId), eq(knowledgeBases.workspaceId, workspaceId)))
      .limit(1);
    return Boolean(row);
  }

  // ---- Documents -------------------------------------------------------------

  async documents(workspaceId: string, baseId: string): Promise<KnowledgeDocumentSummary[] | null> {
    if (!(await this.#owns(workspaceId, baseId))) return null;
    const rows = await this.#db
      .select({
        id: knowledgeDocuments.id,
        baseId: knowledgeDocuments.baseId,
        name: knowledgeDocuments.name,
        mediaType: knowledgeDocuments.mediaType,
        size: knowledgeDocuments.size,
        status: knowledgeDocuments.status,
        error: knowledgeDocuments.error,
        textLength: sql<number>`length(${knowledgeDocuments.text})`,
        graph: knowledgeDocuments.graph,
        graphSource: knowledgeDocuments.graphSource,
        createdAt: knowledgeDocuments.createdAt,
      })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.baseId, baseId))
      .orderBy(desc(knowledgeDocuments.createdAt));
    return rows.map(({ graph, ...row }) => ({
      ...row,
      status: row.status as KnowledgeDocumentSummary["status"],
      textLength: Number(row.textLength),
      entityCount: graph?.entities.length ?? 0,
      relationCount: graph?.relations.length ?? 0,
      graphSource: row.graphSource as KnowledgeDocumentSummary["graphSource"],
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Adds a document: the original is written to disk and the row returned at
   * once as `processing`; reading its text and building its graph happen
   * after, so a large PDF does not hold the upload's request open.
   */
  /** A document sent in one request (small ones, and API callers). */
  async addDocument(
    workspaceId: string,
    baseId: string,
    userId: string,
    file: { name: string; mediaType: string; bytes: Buffer },
  ): Promise<KnowledgeDocumentSummary | null> {
    if (!(await this.#owns(workspaceId, baseId))) return null;
    return this.#register(baseId, userId, file.name, file.mediaType, file.bytes.length, (dest) => writeFile(dest, file.bytes));
  }

  // --- Chunked uploads ------------------------------------------------------
  //
  // A large document arrives as numbered pieces appended to a file under
  // `.knowledge/.uploads/`, then moves into its base on `finishUpload`. The
  // pending uploads live in memory: one cut off by a restart is simply sent
  // again.

  #uploadsDir(): string {
    return join(this.#root, ".uploads");
  }

  /** Starts an upload of `size` bytes; null when the base is not the workspace's. */
  async startUpload(
    workspaceId: string,
    baseId: string,
    userId: string,
    file: { name: string; mediaType: string; size: number },
  ): Promise<{ uploadId: string } | null> {
    if (!(await this.#owns(workspaceId, baseId))) return null;
    await this.#sweepUploads();
    const uploadId = randomUUID();
    const path = join(this.#uploadsDir(), uploadId);
    await mkdir(this.#uploadsDir(), { recursive: true });
    await writeFile(path, "");
    this.#uploads.set(uploadId, {
      workspaceId,
      baseId,
      userId,
      name: file.name,
      mediaType: file.mediaType,
      size: file.size,
      received: 0,
      path,
      touched: Date.now(),
      busy: false,
    });
    return { uploadId };
  }

  #pending(workspaceId: string, baseId: string, uploadId: string): PendingUpload | null {
    const upload = this.#uploads.get(uploadId);
    return upload && upload.workspaceId === workspaceId && upload.baseId === baseId ? upload : null;
  }

  /**
   * Appends one chunk at `offset`. A chunk sent twice (a retry after a lost
   * answer) is refused with how much has arrived, so the sender can carry on
   * from there.
   */
  async appendUpload(
    workspaceId: string,
    baseId: string,
    uploadId: string,
    offset: number,
    chunk: Buffer,
  ): Promise<{ received: number } | UploadRefusal> {
    const upload = this.#pending(workspaceId, baseId, uploadId);
    if (!upload) return { refused: "not_found" };
    if (upload.busy) return { refused: "busy" };
    if (offset !== upload.received) return { refused: "offset", received: upload.received };
    if (upload.received + chunk.length > upload.size) return { refused: "too_big" };
    upload.busy = true;
    try {
      await appendFile(upload.path, chunk);
      upload.received += chunk.length;
      upload.touched = Date.now();
    } finally {
      upload.busy = false;
    }
    return { received: upload.received };
  }

  /** Moves a fully arrived upload into its base as a document, and starts reading it. */
  async finishUpload(
    workspaceId: string,
    baseId: string,
    uploadId: string,
  ): Promise<KnowledgeDocumentSummary | UploadRefusal> {
    const upload = this.#pending(workspaceId, baseId, uploadId);
    if (!upload || !(await this.#owns(workspaceId, baseId))) return { refused: "not_found" };
    if (upload.busy) return { refused: "busy" };
    if (upload.received !== upload.size) return { refused: "incomplete", received: upload.received };
    this.#uploads.delete(uploadId);
    const document = await this.#register(baseId, upload.userId, upload.name, upload.mediaType, upload.size, (dest) =>
      rename(upload.path, dest),
    );
    return document ?? { refused: "not_found" };
  }

  async cancelUpload(workspaceId: string, baseId: string, uploadId: string): Promise<boolean> {
    const upload = this.#pending(workspaceId, baseId, uploadId);
    if (!upload) return false;
    this.#uploads.delete(uploadId);
    await rm(upload.path, { force: true }).catch(this.#onError);
    return true;
  }

  /** Drops uploads gone quiet, and on the first call any partial files a restart left. */
  async #sweepUploads(): Promise<void> {
    if (!this.#sweptStale) {
      this.#sweptStale = true;
      await rm(this.#uploadsDir(), { recursive: true, force: true }).catch(this.#onError);
    }
    const now = Date.now();
    for (const [id, upload] of this.#uploads) {
      if (upload.busy || now - upload.touched < UPLOAD_IDLE_MS) continue;
      this.#uploads.delete(id);
      await rm(upload.path, { force: true }).catch(this.#onError);
    }
  }

  /** Records a document, puts its original in place with `place`, and starts reading it. */
  async #register(
    baseId: string,
    userId: string,
    rawName: string,
    mediaType: string,
    size: number,
    place: (dest: string) => Promise<void>,
  ): Promise<KnowledgeDocumentSummary | null> {
    const name = safeFileName(rawName);
    const [row] = await this.#db
      .insert(knowledgeDocuments)
      .values({ baseId, name, mediaType: mediaType || "application/octet-stream", size, createdBy: userId })
      .returning();
    await mkdir(join(this.#root, baseId), { recursive: true });
    try {
      await place(this.#originalPath(baseId, row!.id));
    } catch (error) {
      await this.#db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, row!.id)).catch(this.#onError);
      throw error;
    }
    await this.#db.update(knowledgeBases).set({ updatedAt: new Date() }).where(eq(knowledgeBases.id, baseId));
    void this.#process(row!, userId).catch(async (error: unknown) => {
      this.#onError(error);
      await this.#db
        .update(knowledgeDocuments)
        .set({ status: "failed", error: error instanceof Error ? error.message : String(error) })
        .where(eq(knowledgeDocuments.id, row!.id))
        .catch(this.#onError);
    });
    const [summary] = await this.#db
      .select({ workspaceId: knowledgeBases.workspaceId })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, baseId))
      .limit(1);
    return summary ? ((await this.documents(summary.workspaceId, baseId))?.find((d) => d.id === row!.id) ?? null) : null;
  }

  /**
   * The bytes to pull a document's text from: the whole file when it is small
   * enough to hold, else the start of a plain-text one. Null, with the reason,
   * for a large file whose format needs all of it.
   */
  async #readable(row: KnowledgeDocumentRow): Promise<{ bytes: Buffer; warning?: string } | { reason: string }> {
    const path = this.#originalPath(row.baseId, row.id);
    const { size } = await stat(path);
    if (size <= READ_WHOLE_MAX_BYTES) return { bytes: await readFile(path) };
    const ext = row.name.includes(".") ? row.name.slice(row.name.lastIndexOf(".") + 1).toLowerCase() : "";
    const big = humanSize(size);
    if (WHOLE_FILE_EXTS.has(ext)) {
      return {
        reason: `This ${ext.toUpperCase()} is ${big}; files that size are kept, but only plain-text ones are read. Split it into parts under 512 MB to make it searchable.`,
      };
    }
    const handle = await open(path, "r");
    try {
      const head = Buffer.alloc(TEXT_HEAD_BYTES);
      const { bytesRead } = await handle.read(head, 0, TEXT_HEAD_BYTES, 0);
      const bytes = head.subarray(0, bytesRead);
      if (!looksLikeText(bytes)) {
        return { reason: `This file is ${big} and is not plain text; files that size are kept, but only plain-text ones are read.` };
      }
      return { bytes, warning: `This file is ${big}: only its first ${humanSize(TEXT_HEAD_BYTES)} were read.` };
    } finally {
      await handle.close();
    }
  }

  async #process(row: KnowledgeDocumentRow, userId: string): Promise<void> {
    const readable = await this.#readable(row);
    if ("reason" in readable) {
      await this.#db
        .update(knowledgeDocuments)
        .set({ status: "failed", error: readable.reason })
        .where(eq(knowledgeDocuments.id, row.id));
      return;
    }
    const extraction = await extractDocument(row.name, row.mediaType, readable.bytes, { maxChars: MAX_DOC_CHARS });
    const text = extraction?.text.trim() ?? "";
    if (!text) {
      await this.#db
        .update(knowledgeDocuments)
        .set({ status: "failed", error: "No text could be read from this file." })
        .where(eq(knowledgeDocuments.id, row.id));
      return;
    }
    // Searchable as soon as its text is in, before the graph is.
    await this.#db
      .update(knowledgeDocuments)
      .set({ text, error: [readable.warning, extraction?.warning].filter(Boolean).join(" ") || null })
      .where(eq(knowledgeDocuments.id, row.id));
    const { graph, source } = await this.#buildGraph(text, userId);
    await this.#db
      .update(knowledgeDocuments)
      .set({ graph, graphSource: source, status: "ready" })
      .where(eq(knowledgeDocuments.id, row.id));
  }

  /** The model's graph when a model and key are there and it answers sensibly; else the heuristic one. */
  async #buildGraph(text: string, userId: string): Promise<{ graph: KnowledgeDocumentGraph; source: "model" | "heuristic" }> {
    const model = this.#graphModel;
    const apiKey = model ? await model.apiKeyFor(userId).catch(() => null) : null;
    if (model && apiKey) {
      try {
        const result = await model.complete(
          {
            apiKey,
            model: model.model,
            maxTokens: 8_000,
            effort: "off",
            messages: [
              { role: "system", content: GRAPH_PROMPT },
              { role: "user", content: graphUserMessage(text.slice(0, GRAPH_SAMPLE_CHARS)) },
            ],
          },
          () => {},
        );
        const parsed = parseGraphJson(result.text);
        if (parsed && parsed.entities.length > 0) return { graph: parsed, source: "model" };
      } catch (error) {
        this.#onError(error);
      }
    }
    return { graph: cleanGraph(heuristicGraph(text)), source: "heuristic" };
  }

  /** Builds a document's graph again, with the model if one can be reached now. */
  async rebuildGraph(workspaceId: string, baseId: string, documentId: string, userId: string): Promise<boolean> {
    if (!(await this.#owns(workspaceId, baseId))) return false;
    const [row] = await this.#db
      .select({ text: knowledgeDocuments.text })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.baseId, baseId)))
      .limit(1);
    if (!row || !row.text) return false;
    await this.#db.update(knowledgeDocuments).set({ status: "processing" }).where(eq(knowledgeDocuments.id, documentId));
    void this.#buildGraph(row.text, userId)
      .then(({ graph, source }) =>
        this.#db
          .update(knowledgeDocuments)
          .set({ graph, graphSource: source, status: "ready" })
          .where(eq(knowledgeDocuments.id, documentId)),
      )
      .catch(this.#onError);
    return true;
  }

  async removeDocument(workspaceId: string, baseId: string, documentId: string): Promise<boolean> {
    if (!(await this.#owns(workspaceId, baseId))) return false;
    const rows = await this.#db
      .delete(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.baseId, baseId)))
      .returning({ id: knowledgeDocuments.id });
    if (rows.length === 0) return false;
    await rm(this.#originalPath(baseId, documentId), { force: true }).catch(this.#onError);
    // Its text goes too: the folder is written again, without it, by the next turn that reads the base.
    await rm(this.#textDir(baseId), { recursive: true, force: true }).catch(this.#onError);
    return true;
  }

  /** The original's bytes, for a download. */
  async original(
    workspaceId: string,
    baseId: string,
    documentId: string,
  ): Promise<{ name: string; mediaType: string; path: string; size: number } | null> {
    if (!(await this.#owns(workspaceId, baseId))) return null;
    const [row] = await this.#db
      .select({ name: knowledgeDocuments.name, mediaType: knowledgeDocuments.mediaType })
      .from(knowledgeDocuments)
      .where(and(eq(knowledgeDocuments.id, documentId), eq(knowledgeDocuments.baseId, baseId)))
      .limit(1);
    if (!row) return null;
    const path = this.#originalPath(baseId, documentId);
    const info = await stat(path).catch(() => null);
    return info?.isFile() ? { ...row, path, size: info.size } : null;
  }

  // ---- Graph and search ------------------------------------------------------

  async graph(workspaceId: string, baseId: string): Promise<KnowledgeGraph | null> {
    if (!(await this.#owns(workspaceId, baseId))) return null;
    const docs = await this.#db
      .select({ id: knowledgeDocuments.id, graph: knowledgeDocuments.graph })
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.baseId, baseId));
    return mergeGraphs(docs);
  }

  /** The bases of `baseIds` that are this workspace's, with their documents' text. */
  async #loadBases(workspaceId: string, baseIds: readonly string[]) {
    if (baseIds.length === 0) return [];
    const bases = await this.#db
      .select()
      .from(knowledgeBases)
      .where(and(eq(knowledgeBases.workspaceId, workspaceId), inArray(knowledgeBases.id, [...baseIds])));
    if (bases.length === 0) return [];
    const docs = await this.#db
      .select({
        id: knowledgeDocuments.id,
        baseId: knowledgeDocuments.baseId,
        name: knowledgeDocuments.name,
        text: knowledgeDocuments.text,
        graph: knowledgeDocuments.graph,
      })
      .from(knowledgeDocuments)
      .where(inArray(knowledgeDocuments.baseId, bases.map((b) => b.id)));
    return bases.map((base) => ({ base, docs: docs.filter((d) => d.baseId === base.id) }));
  }

  async search(workspaceId: string, baseIds: readonly string[], query: string, limit = 10): Promise<KnowledgeHit[]> {
    const loaded = await this.#loadBases(workspaceId, baseIds);
    return rankChunks(query, chunksOf(loaded), limit);
  }

  /**
   * Prepares a knowledge turn: the prompt that names each base's folder,
   * with the passages and graph facts the message matches.
   *
   * Each base's text is kept once, in the server's own store
   * (`.knowledge/<base>/text/`), and the turn is pointed at it there -- never
   * copied into the project. `dirs` are those folders, for the harness to
   * open to the agent read-only. A folder an older version copied into
   * `tree` is removed on the way.
   *
   * Null when none of the bases is this workspace's -- a stale pick from
   * another workspace, or one deleted since -- so the turn runs as usual.
   */
  async forTurn(
    workspaceId: string,
    knowledge: MessageKnowledge,
    text: string,
    tree?: string,
  ): Promise<TurnKnowledge | null> {
    if (tree) await removeLegacyCopy(tree).catch(this.#onError);
    const loaded = await this.#loadBases(workspaceId, knowledge.baseIds);
    if (loaded.length === 0) return null;

    const bases: { name: string; description: string; dir: string; documents: string[] }[] = [];
    const dirs: string[] = [];
    for (const { base, docs } of loaded) {
      const dir = this.#textDir(base.id);
      try {
        await this.#ensureText(dir, base, docs);
        dirs.push(dir);
      } catch (error) {
        this.#onError(error);
      }
      bases.push({ name: base.name, description: base.description, dir, documents: docs.map((d) => d.name) });
    }

    const hits = rankChunks(text, chunksOf(loaded), TURN_HITS);
    const graph = mergeGraphs(loaded.flatMap(({ docs }) => docs));
    const facts = relevantFacts(text, graph);
    return {
      prompt: knowledgePrompt({ scope: knowledge.scope, bases, hits, facts }),
      scope: knowledge.scope,
      baseNames: loaded.map(({ base }) => base.name),
      hits: hits.length,
      dirs,
    };
  }

  /** Where a base's readable text lives: beside its originals, one copy for every turn. */
  #textDir(baseId: string): string {
    return join(this.#root, baseId, TEXT_DIR);
  }

  /**
   * Writes a base's text folder when its documents changed since it was
   * last written, and leaves it alone otherwise. Built aside and swapped
   * in, so a turn reading it never sees half a folder.
   */
  async #ensureText(
    dir: string,
    base: { name: string; description: string },
    docs: { id: string; name: string; text: string; graph: KnowledgeDocumentGraph | null }[],
  ): Promise<void> {
    const stamp = JSON.stringify([
      base.name,
      base.description,
      docs.map((d) => [d.id, d.name, d.text.length, d.graph?.entities.length ?? 0, d.graph?.relations.length ?? 0]).sort(),
    ]);
    const current = await readFile(join(dir, STAMP_FILE), "utf8").catch(() => null);
    if (current === stamp) return;

    const building = `${dir}.${randomUUID()}.tmp`;
    await mkdir(building, { recursive: true });
    try {
      const names = new Set<string>();
      for (const doc of docs) {
        if (!doc.text) continue;
        const safe = safeFileName(doc.name);
        let file = /\.(md|markdown|txt)$/i.test(safe) ? safe.replace(/\.(markdown|txt)$/i, ".md") : `${safe}.md`;
        if (names.has(file)) file = `${doc.id.slice(0, 8)}-${file}`;
        names.add(file);
        await writeFile(join(building, file), `# ${doc.name}\n\n${doc.text}\n`);
      }
      await writeFile(join(building, "graph.json"), JSON.stringify(mergeGraphs(docs)));
      await writeFile(
        join(building, "README.md"),
        `# Knowledge base: ${base.name}\n\n${base.description}\n\nOne Markdown file per document; graph.json holds the entities and relations read out of them. Kept by the harness -- read it, do not edit it.\n`,
      );
      await writeFile(join(building, STAMP_FILE), stamp);
      await rm(dir, { recursive: true, force: true });
      await rename(building, dir);
    } catch (error) {
      await rm(building, { recursive: true, force: true }).catch(() => {});
      // Another turn swapped the same folder in first: theirs is as good.
      if (await stat(join(dir, STAMP_FILE)).then(() => true, () => false)) return;
      throw error;
    }
  }

  /**
   * Removes the `.knowledge/` folders older versions copied into project
   * checkouts and session worktrees under the workspace root. Only folders
   * that carry the harness's own `.gitignore` are touched.
   */
  async removeLegacyCopies(): Promise<number> {
    const root = dirname(this.#root);
    let removed = 0;
    const trees: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".worktrees") {
        for (const project of await readdir(join(root, entry.name), { withFileTypes: true }).catch(() => [])) {
          if (!project.isDirectory()) continue;
          for (const session of await readdir(join(root, entry.name, project.name), { withFileTypes: true }).catch(() => [])) {
            if (session.isDirectory()) trees.push(join(root, entry.name, project.name, session.name));
          }
        }
      } else if (!entry.name.startsWith(".")) {
        trees.push(join(root, entry.name));
      }
    }
    for (const tree of trees) if (await removeLegacyCopy(tree).catch(() => false)) removed++;
    return removed;
  }
}

/** Marks a base's text folder with the documents it was written from. */
const STAMP_FILE = ".stamp";
/** A base's text folder, beside its originals (which are named by uuid). */
const TEXT_DIR = "text";
/** The first line of the `.gitignore` older versions put in a tree's `.knowledge/`. */
const LEGACY_MARKER = "# Knowledge bases copied in for the agent to read.";

/** Removes a tree's `.knowledge/` when the harness wrote it; a project's own is left alone. */
async function removeLegacyCopy(tree: string): Promise<boolean> {
  const folder = join(tree, ".knowledge");
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory()) return false;
  const ignore = await readFile(join(folder, ".gitignore"), "utf8").catch(() => "");
  if (!ignore.startsWith(LEGACY_MARKER)) return false;
  await rm(folder, { recursive: true, force: true });
  return true;
}

function chunksOf(
  loaded: { base: { id: string; name: string }; docs: { id: string; name: string; text: string }[] }[],
): Chunk[] {
  return loaded.flatMap(({ base, docs }) =>
    docs.flatMap((doc) =>
      chunkText(doc.text).map((text) => ({
        baseId: base.id,
        baseName: base.name,
        documentId: doc.id,
        documentName: doc.name,
        text,
      })),
    ),
  );
}
