/**
 * The collab service's entry point: `node dist/collab.mjs`, its own process
 * (deploy/s6/s6-rc.d/collab), so the merging of every editor's keystrokes
 * never shares an event loop with the API. See `collab/server.ts`.
 *
 * Listens on loopback only (`COLLAB_PORT`); browsers reach it through the
 * API's `/collab` upgrade, and the API calls in for content writes. Files
 * are read and written through the API too, which owns the path rules and
 * tells the project's other viewers.
 */
import { createDatabase } from "@ucch/db";

import { createCollab } from "./collab/server.js";
import { noteDocuments } from "./collab/note-documents.js";
import { COLLAB_SECRET_HEADER, collabSecret } from "./collab/secret.js";

const env = process.env;
const secret = collabSecret(env);
if (!secret) throw new Error("the collab service needs SECRET_KEY (or COLLAB_SECRET) in production");
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const port = Number(env.COLLAB_PORT ?? 3002);
const api = env.COLLAB_API_ORIGIN ?? `http://127.0.0.1:${env.PORT ?? 3001}`;
// A handful of connections: saves are debounced, and loads are one row each.
const db = createDatabase(env.DATABASE_URL, { max: Number(env.COLLAB_DB_POOL_MAX ?? 5) });

const log = {
  warn: (obj: object, msg: string) => console.warn(JSON.stringify({ level: "warn", msg, ...describe(obj) })),
  error: (obj: object, msg: string) => console.error(JSON.stringify({ level: "error", msg, ...describe(obj) })),
};

async function callApi(path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, api), {
    method: "POST",
    headers: { "content-type": "application/json", [COLLAB_SECRET_HEADER]: secret! },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

const collab = createCollab({
  port,
  secret,
  maxDocuments: Number(env.COLLAB_MAX_DOCS ?? 200),
  notes: noteDocuments(db),
  log,
  async authorize(token, ref) {
    const response = await callApi("/api/internal/collab/authorize", { token, document: ref });
    if (!response.ok) {
      // 401/404 are a refusal like any other; anything else is worth knowing about.
      if (response.status !== 401 && response.status !== 404) log.warn({ status: response.status }, "authorize failed");
      return null;
    }
    return (await response.json()) as Awaited<ReturnType<Parameters<typeof createCollab>[0]["authorize"]>>;
  },
  files: {
    async read({ projectId, worktreeId, path }) {
      const response = await callApi("/api/internal/collab/files/read", { projectId, worktreeId, path });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`the API answered ${response.status}`);
      return ((await response.json()) as { content: string }).content;
    },
    async write({ projectId, worktreeId, path }, content, userId) {
      const response = await callApi("/api/internal/collab/files/write", { projectId, worktreeId, path, content, userId });
      if (!response.ok) throw new Error(`the API answered ${response.status}`);
    },
  },
  async announce(projectId, noteId, userId) {
    const response = await callApi("/api/internal/collab/saved", { projectId, noteId, userId });
    if (!response.ok) throw new Error(`the API answered ${response.status}`);
  },
});

await collab.listen();
console.log(JSON.stringify({ level: "info", msg: "collab listening", port }));

const shutdown = async () => {
  // Saves whatever is still pending before the documents go.
  collab.instance.flushPendingStores();
  await collab.destroy();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

function describe(obj: object): object {
  const { err, ...rest } = obj as { err?: unknown };
  return err instanceof Error ? { ...rest, err: err.message } : obj;
}
