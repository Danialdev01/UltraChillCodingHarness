/**
 * Which addresses need a session before anything renders.
 *
 * The middleware sends a visitor with no session cookie straight to the
 * sign-in page from here, rather than rendering the app shell only for it to
 * find out and redirect. Only the cookie's *absence* is decided here: whether
 * one that is present is still valid is the API's call, made by the shell.
 */
const PUBLIC = [
  /^\/login(?:\/|$)/,
  /^\/healthz$/,
  /^\/offline$/,
  /^\/dev(?:\/|$)/,
  /^\/(?:icon|apple-icon|icon-\d+|icon-maskable-\d+)(?:\.\w+)?$/,
  /^\/manifest\.webmanifest$/,
  /^\/sw\.js$/,
  /^\/swe-worker-[\w-]+\.js$/,
];

export const SESSION_COOKIE = "ucch_session";

export function needsSession(pathname: string): boolean {
  return !PUBLIC.some((pattern) => pattern.test(pathname));
}

/**
 * Where to come back to after signing in: the page asked for, when it is one
 * of this app's own paths. Anything else -- another origin, a protocol-
 * relative `//host`, the sign-in page itself -- lands on the home page.
 */
export function safeNext(next: string | null | undefined): string | null {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return null;
  if (/^\/login(?:[/?#]|$)/.test(next) || /^\/api(?:\/|$)/.test(next)) return null;
  return next;
}
