import { connect } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { NoteDoc } from "@ucch/protocol";

import { COLLAB_SECRET_HEADER } from "./collab/secret.js";
import { registry, type Gauge } from "./metrics.js";

/**
 * The API's side of the collab service (`collab.ts`, its own process):
 *
 * - browsers' `/collab` WebSocket upgrades, passed through to it byte for
 *   byte, the way the rest of the public port is passed to the web app;
 * - content written from outside an editor, sent into the document there
 *   (`writeNote`), and files changed on disk, which an open document of
 *   them rereads (`filesChanged`);
 * - its open-document count, for `/metrics`.
 */
export class CollabLink {
  readonly #upstream: URL;
  readonly #secret: string;
  readonly #log: { error(obj: object, msg: string): void } | undefined;

  constructor(options: { upstream: string; secret: string; log?: { error(obj: object, msg: string): void } }) {
    this.#upstream = new URL(options.upstream);
    this.#secret = options.secret;
    this.#log = options.log;
    // One request per scrape for both, and nothing reported while the service is down.
    const report = (key: "documents" | "connections") => async (gauge: Gauge) => {
      const stats = await this.#scrape();
      if (stats) gauge.set({}, stats[key]);
      else gauge.reset();
    };
    registry.gauge("collab_open_documents", "Documents the collab service holds open", [], report("documents"));
    registry.gauge("collab_connections", "Editors connected to the collab service", [], report("connections"));
  }

  #scraped: { at: number; stats: Promise<{ documents: number; connections: number } | null> } | null = null;

  #scrape() {
    if (!this.#scraped || Date.now() - this.#scraped.at > 1000) this.#scraped = { at: Date.now(), stats: this.stats() };
    return this.#scraped.stats;
  }

  /** True when this took the upgrade. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const pathname = (request.url ?? "/").split("?")[0]!;
    if (pathname !== "/collab" && !pathname.startsWith("/collab/")) return false;
    const upstream = connect(Number(this.#upstream.port || 80), this.#upstream.hostname, () => {
      let lines = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        lines += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(`${lines}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", (error) => {
      this.#log?.error({ err: error }, "collab service unreachable");
      if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      close();
    });
    socket.on("error", close);
    socket.on("close", () => upstream.destroy());
    return true;
  }

  /** Replaces a note's body through its document. False when the service could not take it. */
  async writeNote(noteId: string, content: NoteDoc): Promise<boolean> {
    try {
      const response = await fetch(new URL(`/internal/notes/${noteId}/content`, this.#upstream), {
        method: "PUT",
        headers: { "content-type": "application/json", [COLLAB_SECRET_HEADER]: this.#secret },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10_000),
      });
      return response.ok;
    } catch (error) {
      this.#log?.error({ err: error, noteId }, "could not write a note through the collab service");
      return false;
    }
  }

  /** By tree: the paths changed in this beat, or null for "too many to name". */
  readonly #changed = new Map<string, { projectId: string; worktreeId: string; paths: Set<string> | null }>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #unreachableLogged = 0;

  /**
   * A file changed on disk -- or, with `path` null, more of the tree than
   * was named. Collected for a beat and sent as one call per tree: an agent
   * turn or a checkout changes files by the dozen.
   */
  filesChanged(projectId: string, worktreeId: string, path: string | null): void {
    const key = `${projectId}\0${worktreeId}`;
    const entry = this.#changed.get(key) ?? { projectId, worktreeId, paths: new Set<string>() };
    if (path === null) entry.paths = null;
    else entry.paths?.add(path);
    this.#changed.set(key, entry);
    this.#flushTimer ??= setTimeout(() => this.#flushChanged(), 50);
  }

  #flushChanged(): void {
    this.#flushTimer = null;
    const batches = [...this.#changed.values()];
    this.#changed.clear();
    for (const { projectId, worktreeId, paths } of batches) {
      void fetch(new URL("/internal/files/changed", this.#upstream), {
        method: "POST",
        headers: { "content-type": "application/json", [COLLAB_SECRET_HEADER]: this.#secret },
        body: JSON.stringify({ projectId, worktreeId, paths: paths ? [...paths] : null }),
        signal: AbortSignal.timeout(10_000),
      }).catch((error: unknown) => {
        // The service is down: its documents are gone with it, and reopened
        // from disk. Said once a minute, not once per file the agent writes.
        if (Date.now() - this.#unreachableLogged < 60_000) return;
        this.#unreachableLogged = Date.now();
        this.#log?.error({ err: error, projectId }, "could not tell the collab service a file changed");
      });
    }
  }

  async stats(): Promise<{ documents: number; connections: number } | null> {
    try {
      const response = await fetch(new URL("/internal/stats", this.#upstream), {
        headers: { [COLLAB_SECRET_HEADER]: this.#secret },
        signal: AbortSignal.timeout(1000),
      });
      return response.ok ? ((await response.json()) as { documents: number; connections: number }) : null;
    } catch {
      return null;
    }
  }
}
