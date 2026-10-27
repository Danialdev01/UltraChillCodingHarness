import { Server, type DirectConnection, type Document } from "@hocuspocus/server";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as Y from "yjs";
import type { NoteDoc } from "@ucch/protocol";

import { FILE_FIELD, NOTE_FIELD, noteDocumentName, parseDocumentName, type DocumentRef } from "./documents.js";
import { rebase } from "./file-merge.js";
import { readDocFromFragment, writeDocToFragment } from "./prosemirror-y.js";
import { COLLAB_SECRET_HEADER } from "./secret.js";

/** Who is editing, as the API vouched for them. */
export interface CollabAccess {
  userId: string;
  projectId: string;
  readOnly: boolean;
}

/** Where notes' documents live: the database, behind the collab service. */
export interface NoteDocuments {
  /** The stored state, or the content to seed it from; null for no such note. */
  load(noteId: string): Promise<{ state: Uint8Array | null; content: NoteDoc } | null>;
  /** Keeps `state` unless another one got there first, and returns whichever is kept. */
  seed(noteId: string, state: Uint8Array): Promise<Uint8Array>;
  /** Saves the state and its projection; the note's project, or null if it is gone. */
  store(noteId: string, state: Uint8Array, content: NoteDoc): Promise<{ projectId: string } | null>;
}

export type FileRef = Extract<DocumentRef, { kind: "file" }>;

/**
 * Where files' documents come from: the project's tree on disk, read and
 * written through the API, which owns the path rules and tells everyone else
 * about the write. Nothing about a file's document is stored: the disk is
 * the state.
 */
export interface FileDocuments {
  /** The file's text; null when it is missing, not text, too large, or refused. */
  read(ref: FileRef): Promise<string | null>;
  /** Writes the document's text back, as `userId`'s edit. */
  write(ref: FileRef, text: string, userId: string | undefined): Promise<void>;
}

export interface CollabOptions {
  port?: number;
  address?: string;
  /** Redeems the client's ticket for the document it names; null refuses it. */
  authorize(token: string, ref: DocumentRef): Promise<CollabAccess | null>;
  notes: NoteDocuments;
  files?: FileDocuments;
  /** How long after the last keystroke a file is written back. */
  fileWriteMs?: number;
  /** A note's body was saved, last edited by `userId`: tell its project's other viewers. */
  announce(projectId: string, noteId: string, userId: string | undefined): Promise<void>;
  /** For the API's calls in: content writes, the open-document count. */
  secret: string;
  maxDocuments?: number;
  /** How long a document stays loaded after its last editor leaves. */
  idleUnloadMs?: number;
  debounceMs?: number;
  maxDebounceMs?: number;
  log?: { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
}

/**
 * The collaborative documents service: Hocuspocus, in a process of its own.
 *
 * Editing is merged here -- every keystroke from every editor of a note goes
 * through this process rather than the API's event loop -- and the result
 * is saved as the Yjs state (`note_ydocs`) plus a projection to
 * `notes.content`, which everything else (search, the public site, the
 * agent) goes on reading. A save is debounced 2 s, and never more than 10 s
 * behind.
 *
 * The API stays the authority on who may edit what: a client's ticket is
 * redeemed by it (`authorize`), and the service trusts its answer.
 */
export function createCollab(options: CollabOptions) {
  const idleUnloadMs = options.idleUnloadMs ?? 30_000;
  const maxDocuments = options.maxDocuments ?? 200;
  /** A document's state vector as last saved: an unchanged document is not saved again. */
  const saved = new Map<string, Uint8Array>();
  /** Documents with no editor left, held open for `idleUnloadMs` so a quick return finds them loaded. */
  const holds = new Map<string, { connection: Promise<DirectConnection>; timer: ReturnType<typeof setTimeout> }>();
  /** Shutting down: documents are let go, not held. */
  let closing = false;
  /**
   * Documents whose own direct connection is closing -- a hold running out,
   * a write from the API. Their disconnect fires `onDisconnect` like an
   * editor's would, and must not start another hold.
   */
  const releasing = new Set<string>();
  /** Each open file's text as last read from or written to disk. */
  const disk = new Map<string, string>();
  /** Files waiting to be written back, and who last typed in each. */
  const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastEditor = new Map<string, string | undefined>();
  /** One write or reload per file at a time, in order. */
  const fileQueue = new Map<string, Promise<void>>();

  const server = new Server<{ access?: CollabAccess; system?: boolean }>({
    port: options.port ?? 0,
    address: options.address ?? "127.0.0.1",
    quiet: true,
    stopOnSignals: false,
    debounce: options.debounceMs ?? 2000,
    maxDebounce: options.maxDebounceMs ?? 10_000,
    // Saved before it is unloaded, so the last edit is never dropped.
    unloadImmediately: false,

    async onAuthenticate({ token, documentName, instance, connectionConfig }) {
      const ref = parseDocumentName(documentName);
      if (!ref) throw new Error("no such document");
      if (!instance.documents.has(documentName) && instance.getDocumentsCount() >= maxDocuments) {
        throw new Error("too many open documents");
      }
      const access = await options.authorize(token, ref);
      if (!access) throw new Error("not allowed");
      connectionConfig.readOnly = access.readOnly;
      return { access };
    },

    async onLoadDocument({ documentName, document }) {
      const ref = parseDocumentName(documentName);
      if (ref?.kind === "file") {
        const text = options.files ? await options.files.read(ref) : null;
        if (text === null) throw new Error("no such file");
        document.getText(FILE_FIELD).insert(0, text);
        disk.set(documentName, text);
        return document;
      }
      if (ref?.kind !== "note") throw new Error("no such document");
      const row = await options.notes.load(ref.noteId);
      if (!row) throw new Error("no such note");
      let state = row.state;
      if (!state) {
        // Seeded once and kept at once: two loads seeding separately would
        // each make their own copy of every paragraph, and a client holding
        // one would merge it in beside the other.
        const seed = new Y.Doc();
        writeDocToFragment(seed.getXmlFragment(NOTE_FIELD), row.content);
        state = await options.notes.seed(ref.noteId, Y.encodeStateAsUpdate(seed));
      }
      Y.applyUpdate(document, state);
      saved.set(documentName, Y.encodeStateVector(document));
      return document;
    },

    async onChange({ documentName, context }) {
      if (parseDocumentName(documentName)?.kind !== "file" || context?.system) return;
      lastEditor.set(documentName, context?.access?.userId);
      clearTimeout(writeTimers.get(documentName));
      const timer = setTimeout(() => {
        writeTimers.delete(documentName);
        void writeFile(documentName);
      }, options.fileWriteMs ?? 1000);
      timer.unref?.();
      writeTimers.set(documentName, timer);
    },

    async onStoreDocument({ documentName, document, lastContext }) {
      const ref = parseDocumentName(documentName);
      // Before an unload too: whatever the timer has not written yet goes now.
      if (ref?.kind === "file") {
        clearTimeout(writeTimers.get(documentName));
        writeTimers.delete(documentName);
        return writeFile(documentName, document);
      }
      if (ref?.kind !== "note") return;
      const vector = Y.encodeStateVector(document);
      if (sameBytes(saved.get(documentName), vector)) return;
      const content = readDocFromFragment(document.getXmlFragment(NOTE_FIELD));
      const stored = await options.notes.store(ref.noteId, Y.encodeStateAsUpdate(document), content);
      saved.set(documentName, vector);
      // A write from the API announces and logs itself (notes-routes.ts).
      if (stored && !lastContext?.system) {
        await options.announce(stored.projectId, ref.noteId, lastContext?.access?.userId).catch((error) => {
          options.log?.warn({ err: error, noteId: ref.noteId }, "could not announce a note save");
        });
      }
    },

    async onDisconnect({ documentName, document }) {
      if (document.connections.size === 0 && !releasing.has(documentName)) hold(documentName);
    },

    async afterUnloadDocument({ documentName }) {
      saved.delete(documentName);
      disk.delete(documentName);
      lastEditor.delete(documentName);
      clearTimeout(writeTimers.get(documentName));
      writeTimers.delete(documentName);
    },

    async onRequest({ request, response }) {
      if (!request.url?.startsWith("/internal/")) return;
      await internal(request, response).catch((error) => {
        options.log?.error({ err: error, url: request.url }, "internal collab request failed");
        if (!response.headersSent) response.writeHead(500).end();
      });
      // Handled: a rejection is how a hook stops Hocuspocus's own reply.
      throw null;
    },
  });

  const instance = server.hocuspocus;

  function hold(documentName: string): void {
    if (closing) return;
    const held = holds.get(documentName);
    if (held) clearTimeout(held.timer);
    const connection = held?.connection ?? instance.openDirectConnection(documentName, {});
    const timer = setTimeout(() => {
      holds.delete(documentName);
      void release(documentName, connection);
    }, idleUnloadMs);
    timer.unref?.();
    holds.set(documentName, { connection, timer });
  }

  /** Closes a direct connection of ours: saved, and unloaded if nobody else has it open. */
  async function release(documentName: string, connection: Promise<DirectConnection> | DirectConnection) {
    releasing.add(documentName);
    try {
      await (await connection).disconnect();
    } catch {
      // Already gone with the document.
    } finally {
      releasing.delete(documentName);
    }
  }

  /**
   * Replaces a note's body from outside the editor -- the REST content
   * write, the agent -- through the document, so every open editor gets it
   * as an ordinary change, and saves it before answering.
   */
  async function applyNote(noteId: string, content: NoteDoc): Promise<void> {
    const name = noteDocumentName(noteId);
    const connection = await instance.openDirectConnection(name, { system: true });
    try {
      await connection.transact((document) => writeDocToFragment(document.getXmlFragment(NOTE_FIELD), content));
    } finally {
      await release(name, connection);
    }
  }

  /** Runs `job` after whatever is already queued for the file. */
  function queued(documentName: string, job: () => Promise<void>): Promise<void> {
    const next = (fileQueue.get(documentName) ?? Promise.resolve()).then(job).catch((error: unknown) => {
      options.log?.error({ err: error, documentName }, "file document write-back failed");
    });
    fileQueue.set(documentName, next);
    void next.finally(() => {
      if (fileQueue.get(documentName) === next) fileQueue.delete(documentName);
    });
    return next;
  }

  /** Writes the file's document to disk, unless the disk already holds it. */
  function writeFile(documentName: string, loaded?: Document): Promise<void> {
    return queued(documentName, async () => {
      const ref = parseDocumentName(documentName);
      const document = loaded ?? instance.documents.get(documentName);
      if (ref?.kind !== "file" || !document || !options.files) return;
      const text = document.getText(FILE_FIELD).toString();
      if (text === disk.get(documentName)) return;
      await options.files.write(ref, text, lastEditor.get(documentName));
      disk.set(documentName, text);
    });
  }

  /**
   * The file changed on disk under an open document -- the agent, a
   * terminal, git. The change goes into the document as one edit, so every
   * editor's cursor stays where it was; edits typed here and not yet
   * written are kept where they do not overlap it (`rebase`).
   */
  function reloadFile(documentName: string): Promise<void> {
    return queued(documentName, async () => {
      const ref = parseDocumentName(documentName);
      if (ref?.kind !== "file" || !options.files || !instance.documents.has(documentName)) return;
      const text = await options.files.read(ref);
      const before = disk.get(documentName);
      // Deleted, or our own write coming back: nothing to take.
      if (text === null || before === undefined || text === before) return;
      disk.set(documentName, text);
      const connection = await instance.openDirectConnection(documentName, { system: true });
      try {
        await connection.transact((document) => {
          const ytext = document.getText(FILE_FIELD);
          const change = rebase(before, ytext.toString(), text);
          if (!change) return;
          if (change.to > change.from) ytext.delete(change.from, change.to - change.from);
          if (change.insert) ytext.insert(change.from, change.insert);
        });
      } finally {
        // Not awaited: closing it stores the document, and that write queues
        // behind this very job.
        void release(documentName, connection);
      }
    });
  }

  /** The open documents of one tree's files: all of them, or those at `paths`. */
  function reloadFiles(projectId: string, worktreeId: string, paths: readonly string[] | null): Promise<void> {
    const wanted = paths ? new Set(paths) : null;
    const names = [...instance.documents.keys()].filter((name) => {
      const ref = parseDocumentName(name);
      return (
        ref?.kind === "file" &&
        ref.projectId === projectId &&
        ref.worktreeId === worktreeId &&
        (!wanted || wanted.has(ref.path))
      );
    });
    return Promise.all(names.map(reloadFile)).then(() => {});
  }

  async function internal(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers[COLLAB_SECRET_HEADER] !== options.secret) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url!, "http://collab");
    if (request.method === "GET" && url.pathname === "/internal/stats") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ documents: instance.getDocumentsCount(), connections: instance.getConnectionsCount() }));
      return;
    }
    const note = /^\/internal\/notes\/([0-9a-f-]{36})\/content$/.exec(url.pathname);
    if (request.method === "PUT" && note) {
      const body = JSON.parse(await readBody(request)) as { content?: NoteDoc };
      if (body.content?.type !== "doc") {
        response.writeHead(400).end();
        return;
      }
      await applyNote(note[1]!, body.content);
      response.writeHead(204).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/internal/files/changed") {
      const body = JSON.parse(await readBody(request)) as { projectId?: unknown; worktreeId?: unknown; paths?: unknown };
      if (
        typeof body.projectId !== "string" ||
        typeof body.worktreeId !== "string" ||
        !(body.paths === null || (Array.isArray(body.paths) && body.paths.every((p) => typeof p === "string")))
      ) {
        response.writeHead(400).end();
        return;
      }
      await reloadFiles(body.projectId, body.worktreeId, body.paths as string[] | null);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  }

  return {
    server,
    instance,
    applyNote,
    reloadFiles,
    async listen(): Promise<number> {
      await server.listen();
      return server.address.port;
    },
    async destroy(): Promise<void> {
      closing = true;
      const released = [...holds].map(([documentName, { timer, connection }]) => {
        clearTimeout(timer);
        return release(documentName, connection);
      });
      holds.clear();
      await Promise.all(released);
      for (const timer of writeTimers.values()) clearTimeout(timer);
      await server.destroy();
    },
  };
}

export type Collab = ReturnType<typeof createCollab>;

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return a !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function readBody(request: IncomingMessage, limit = 16 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type { Document };
