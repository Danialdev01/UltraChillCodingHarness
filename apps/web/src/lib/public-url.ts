/**
 * The address the browser actually used, for redirects the middleware sends.
 *
 * Behind the server's proxy (apps/server/src/web-proxy.ts) the standalone
 * build listens on loopback, and Next builds `request.nextUrl` from its own
 * listen address, not the Host header. A redirect made from a clone of it
 * would send the browser to `http://localhost:3100/...`. The proxies in front
 * (Traefik, then the server) say where the request really arrived in
 * X-Forwarded-Host and X-Forwarded-Proto; without them -- `next dev`, reached
 * directly -- the URL is already right and is returned as it is.
 */
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

export function publicUrl(url: URL, headers: Headers): URL {
  const out = new URL(url);
  const host = first(headers.get("x-forwarded-host"));
  if (!host || !HOST.test(host)) return out;
  const proto = first(headers.get("x-forwarded-proto"));
  if (proto === "http" || proto === "https") out.protocol = `${proto}:`;
  out.host = host;
  // A host without a port means the scheme's own, not the loopback one.
  if (!host.includes(":")) out.port = "";
  return out;
}

/** The first of a comma-separated list, as a chain of proxies appends. */
function first(value: string | null): string | undefined {
  return value?.split(",", 1)[0]?.trim() || undefined;
}
