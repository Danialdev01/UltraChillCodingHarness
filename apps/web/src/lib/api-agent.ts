import { Agent } from "undici";

/**
 * The connection pool every server render talks to the API through.
 *
 * Without it each render's fetches share Node's default pool, which lets an
 * idle socket go after four seconds -- so a page opened after a short pause
 * starts with a TCP handshake per request. Thirty seconds outlasts the gaps
 * between clicks, and thirty-two sockets is more than one render's fan-out.
 * Kept on `globalThis` so a dev reload reuses the pool rather than leaking
 * one per edit. Server-only: undici is Node's, not the browser's.
 */
const KEY = Symbol.for("ucch.apiAgent");
const store = globalThis as typeof globalThis & { [KEY]?: Agent };
const agent = (store[KEY] ??= new Agent({ keepAliveTimeout: 30_000, connections: 32 }));

/** `fetch`, over the pooled connections. For server-side calls to the API only. */
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  // Node's fetch takes undici's `dispatcher`; the DOM `RequestInit` type does not list it.
  return fetch(url, { ...init, dispatcher: agent } as RequestInit);
}
