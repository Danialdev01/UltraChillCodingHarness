/**
 * Request checks that apply to the whole API rather than to one route.
 *
 * Kept out of `index.ts` so they can be tested without booting the server.
 */

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Hosts a development browser may legitimately post from. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a request that changes something came from the app itself.
 *
 * The session cookie is `SameSite=Lax`, which stops another *site* sending
 * it -- but a live preview at `p{port}-{hash}.ROOT_DOMAIN` is the same site,
 * and runs whatever code the project contains. Without this, a cloned
 * repository's page could post to the API with the visitor's session.
 *
 * A request with no `Origin` is let through: browsers send one on every
 * cross-origin and every same-origin POST, so its absence means a non-browser
 * caller -- the web server's own fetches, curl, the tests -- which a cookie
 * cannot be ridden from.
 */
export function originAllowed(
  method: string,
  origin: string | undefined,
  allowed: ReadonlySet<string>,
  allowLoopback: boolean,
): boolean {
  if (!UNSAFE_METHODS.has(method.toUpperCase())) return true;
  if (origin === undefined || origin === "") return true;
  if (allowed.has(origin)) return true;
  if (allowLoopback) {
    try {
      return LOOPBACK.has(new URL(origin).host.replace(/:\d+$/, ""));
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Headers every API response carries unless the route set its own.
 *
 * The API serves JSON and a few deliberately sandboxed files; none of it is
 * meant to be framed or sniffed into something else.
 */
export const BASELINE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
};
