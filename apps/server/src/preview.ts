import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { parseHost } from "@ucch/protocol";

/**
 * The live-preview gateway: `p{port}-{hash}.{root}` reverse-proxied to the
 * owner's dev server.
 *
 * It sits *in front of* Fastify rather than inside it. A preview host's paths
 * are the user's app's paths -- `/health`, `/api/me`, anything -- and Fastify
 * routes by path before it looks at the host, so a route registered for the
 * API would answer on the preview host too. Dispatching on the raw request
 * keeps the two namespaces apart: a project host never reaches the router.
 *
 * Authorization is a cookie scoped to the preview host, because the session
 * cookie is host-only on the root domain and never arrives here. The web app's
 * `/{hash}/preview` alias (which does get the session) checks ownership and
 * mints a single-use ticket; `/__ucch/auth` on the preview host swaps the
 * ticket for the cookie. The cookie is an HMAC over {project, user, port,
 * expiry}, so nothing has to be stored for it and a restart does not log
 * anyone out of their preview.
 *
 * The proxy target is derived here, never taken from the request: only the
 * port is the user's, and it has to equal the one stored on the project.
 * Without that rule a preview cookie for one project would let its holder
 * reach any port on the host through a hand-edited hostname.
 */

export interface PreviewGrant {
  projectId: string;
  userId: string;
  port: number;
}

export interface PreviewProject {
  id: string;
  userId: string;
  previewPort: number | null;
}

export interface PreviewGatewayOptions {
  rootDomain: string;
  scheme: "http" | "https";
  /** Where to send a visitor without a valid cookie, to pick one up. */
  webOrigin: string;
  /** Signs the cookie. Absent, a per-process key: previews survive as long as the server. */
  secret?: string;
  resolve: (hash: string) => Promise<PreviewProject | null>;
  /**
   * Where the project's dev server actually is. Several hosts because a
   * loopback server may be on either family: Vite binds `::1` unless told
   * otherwise, `php artisan serve` binds `127.0.0.1`. The first one that
   * accepts a connection is used. Loopback until containers arrive.
   */
  target: (project: PreviewProject, port: number) => { hosts: string[]; port: number };
  /** Accept any visitor -- for the same development setup as DEV_AUTH_BYPASS. */
  devBypass?: boolean;
  log: { error(obj: object, msg: string): void };
  now?: () => number;
}

export const PREVIEW_COOKIE = "ucch_preview";
const AUTH_PATH = "/__ucch/auth";
const TICKET_TTL_MS = 60_000;
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000;
/** How long a hash -> project lookup, or a host choice, is trusted before asking again. */
const RESOLVE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 500;

/** Cookies that belong to the harness and must never reach the user's app. */
const HARNESS_COOKIES = new Set([PREVIEW_COOKIE, "ucch_session", "ucch_oauth_state", "ucch_workspace"]);

/** Headers that describe this hop, not the message; forwarding them confuses the next hop. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class PreviewGateway {
  readonly #tickets = new Map<string, { grant: PreviewGrant; expiresAt: number }>();
  readonly #resolved = new Map<string, { project: PreviewProject | null; expiresAt: number }>();
  /** Which of a target's hosts answered last, by port. */
  readonly #reachable = new Map<number, { host: string; expiresAt: number }>();
  readonly #secret: Buffer;
  readonly #now: () => number;

  constructor(private readonly options: PreviewGatewayOptions) {
    this.#secret = options.secret ? Buffer.from(options.secret, "utf8") : randomBytes(32);
    this.#now = options.now ?? Date.now;
  }

  // -- Tickets -------------------------------------------------------------

  issueTicket(grant: PreviewGrant): string {
    this.#sweep();
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { grant, expiresAt: this.#now() + TICKET_TTL_MS });
    return ticket;
  }

  /** Single-use: consumed whether or not it turns out to be valid. */
  redeemTicket(ticket: string | undefined): PreviewGrant | null {
    if (!ticket) return null;
    const entry = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (!entry || entry.expiresAt < this.#now()) return null;
    return entry.grant;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [ticket, entry] of this.#tickets) {
      if (entry.expiresAt < now) this.#tickets.delete(ticket);
    }
  }

  /** Forget a cached lookup, so a port just saved is served at once. */
  invalidate(hash: string): void {
    this.#resolved.delete(hash);
  }

  /** Whether `host` accepts connections on `port` right now. */
  static probe(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = netConnect({ host, port });
      const done = (listening: boolean) => {
        socket.destroy();
        resolve(listening);
      };
      socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  }

  /** The first of `hosts` that accepts a connection on `port`, or null. */
  static async reachable(hosts: string[], port: number): Promise<string | null> {
    for (const host of hosts) {
      if (await PreviewGateway.probe(port, host)) return host;
    }
    return null;
  }

  /** Whether the project's dev server is up, wherever it bound. */
  listening(project: PreviewProject, port: number): Promise<boolean> {
    return PreviewGateway.reachable(this.options.target(project, port).hosts, port).then(Boolean);
  }

  /**
   * Picks the host to proxy to. The choice is remembered briefly so a page
   * of fifty asset requests does not probe fifty times; when nothing
   * answers, the first host is used so the request fails with an honest
   * connection error rather than a guess.
   */
  async #connectTarget(project: PreviewProject, port: number): Promise<{ host: string; port: number }> {
    const target = this.options.target(project, port);
    const cached = this.#reachable.get(target.port);
    if (cached && cached.expiresAt > this.#now()) return { host: cached.host, port: target.port };

    const host = await PreviewGateway.reachable(target.hosts, target.port);
    if (host) this.#reachable.set(target.port, { host, expiresAt: this.#now() + RESOLVE_TTL_MS });
    return { host: host ?? target.hosts[0]!, port: target.port };
  }

  // -- Cookie --------------------------------------------------------------

  #sign(payload: string): string {
    return createHmac("sha256", this.#secret).update(payload).digest("base64url");
  }

  #mintCookie(grant: PreviewGrant): string {
    const payload = Buffer.from(
      JSON.stringify({ p: grant.projectId, u: grant.userId, n: grant.port, exp: this.#now() + COOKIE_TTL_MS }),
    ).toString("base64url");
    return `${payload}.${this.#sign(payload)}`;
  }

  #verifyCookie(value: string | undefined, project: PreviewProject, port: number): boolean {
    if (!value) return false;
    const dot = value.lastIndexOf(".");
    if (dot < 0) return false;
    const payload = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.#sign(payload));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
        p?: unknown;
        n?: unknown;
        exp?: unknown;
      };
      return (
        claims.p === project.id &&
        claims.n === port &&
        typeof claims.exp === "number" &&
        claims.exp > this.#now()
      );
    } catch {
      return false;
    }
  }

  #cookieHeader(value: string): string {
    const secure = this.options.scheme === "https" ? "; Secure" : "";
    return `${PREVIEW_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_TTL_MS / 1000}; HttpOnly; SameSite=Lax${secure}`;
  }

  // -- Dispatch ------------------------------------------------------------

  /**
   * Claims the request if it is for a preview host. Returns synchronously so
   * the caller can fall through to Fastify for everything else; the work
   * itself continues asynchronously on the response.
   */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const host = parseHost(req.headers.host ?? "", this.options.rootDomain);
    if (host.kind !== "project") return false;

    void this.#serve(host.projectHash, host.port, req, res).catch((err) => {
      this.options.log.error({ err, host: req.headers.host }, "preview request failed");
      if (!res.headersSent) sendHtml(res, 500, "Preview error", "Something went wrong serving this preview.");
      else res.destroy();
    });
    return true;
  }

  /** The same, for a WebSocket upgrade. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const host = parseHost(req.headers.host ?? "", this.options.rootDomain);
    if (host.kind !== "project") return false;

    void this.#serveUpgrade(host.projectHash, host.port, req, socket, head).catch((err) => {
      this.options.log.error({ err, host: req.headers.host }, "preview upgrade failed");
      rejectSocket(socket, "500 Internal Server Error");
    });
    return true;
  }

  async #resolve(hash: string): Promise<PreviewProject | null> {
    const cached = this.#resolved.get(hash);
    if (cached && cached.expiresAt > this.#now()) return cached.project;
    const project = await this.options.resolve(hash);
    this.#resolved.set(hash, { project, expiresAt: this.#now() + RESOLVE_TTL_MS });
    return project;
  }

  /** Where to send somebody who needs a cookie: back through the alias, which re-issues one. */
  #aliasUrl(hash: string, path: string): string {
    return `${this.options.webOrigin}/${hash}/preview${path === "/" ? "" : path}`;
  }

  async #serve(hash: string, port: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const project = await this.#resolve(hash);
    if (!project || project.previewPort !== port) {
      sendHtml(
        res,
        404,
        "No preview here",
        `No project publishes a preview on port ${port} at this address. Set the port from the project's Preview button.`,
      );
      return;
    }

    const url = new URL(req.url ?? "/", "http://preview");

    if (url.pathname === AUTH_PATH) {
      const grant = this.redeemTicket(url.searchParams.get("t") ?? undefined);
      if (!grant || grant.projectId !== project.id || grant.port !== port) {
        sendHtml(res, 403, "Preview link expired", "That link has already been used or has expired. Open the preview again from the project page.");
        return;
      }
      res.writeHead(302, {
        "set-cookie": this.#cookieHeader(this.#mintCookie(grant)),
        location: safeNext(url.searchParams.get("next")),
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    if (!this.options.devBypass && !this.#verifyCookie(cookies.get(PREVIEW_COOKIE), project, port)) {
      res.writeHead(302, { location: this.#aliasUrl(hash, req.url ?? "/"), "cache-control": "no-store" });
      res.end();
      return;
    }

    const target = await this.#connectTarget(project, port);
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, this.options.scheme),
    });

    upstream.on("response", (proxied) => {
      const headers = { ...proxied.headers };
      for (const name of HOP_BY_HOP) delete headers[name];
      res.writeHead(proxied.statusCode ?? 502, headers);
      proxied.pipe(res);
    });
    upstream.on("error", (err: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendHtml(res, 502, `Nothing on port ${port}`, notListening(port, err));
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  async #serveUpgrade(
    hash: string,
    port: number,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const project = await this.#resolve(hash);
    if (!project || project.previewPort !== port) {
      rejectSocket(socket, "404 Not Found");
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    if (!this.options.devBypass && !this.#verifyCookie(cookies.get(PREVIEW_COOKIE), project, port)) {
      rejectSocket(socket, "401 Unauthorized");
      return;
    }

    const target = await this.#connectTarget(project, port);
    const upstream = httpRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req, this.options.scheme, { upgrade: true }),
    });

    upstream.on("upgrade", (proxied, proxiedSocket, proxiedHead) => {
      const lines = [`HTTP/1.1 ${proxied.statusCode ?? 101} ${proxied.statusMessage ?? "Switching Protocols"}`];
      for (let i = 0; i < proxied.rawHeaders.length; i += 2) {
        lines.push(`${proxied.rawHeaders[i]}: ${proxied.rawHeaders[i + 1]}`);
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (proxiedHead.length) socket.write(proxiedHead);
      if (head.length) proxiedSocket.write(head);
      proxiedSocket.pipe(socket).pipe(proxiedSocket);
      proxiedSocket.on("error", () => socket.destroy());
      socket.on("error", () => proxiedSocket.destroy());
    });
    // A dev server that answers an upgrade with a plain response (a 4xx,
    // say) is relayed as that status and then closed -- there is no socket
    // to keep.
    upstream.on("response", (proxied) => {
      rejectSocket(socket, `${proxied.statusCode ?? 502} ${proxied.statusMessage ?? ""}`.trim());
      upstream.destroy();
    });
    upstream.on("error", () => rejectSocket(socket, "502 Bad Gateway"));
    socket.on("close", () => upstream.destroy());
    upstream.end();
  }
}

// -- Helpers ---------------------------------------------------------------

function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * The incoming headers as the dev server should see them: hop-by-hop headers
 * dropped, the harness's own cookies removed, and the forwarding trail
 * extended. `Host` is kept -- it is what the app uses to build absolute URLs,
 * and the preview hostname is exactly the one it should be building.
 */
function forwardedHeaders(
  req: IncomingMessage,
  scheme: string,
  opts: { upgrade?: boolean } = {},
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(name)) continue;
    if (name === "cookie") {
      const kept = String(value)
        .split(";")
        .map((c) => c.trim())
        .filter((c) => c && !HARNESS_COOKIES.has(c.split("=")[0]!.trim()));
      if (kept.length) out.cookie = kept.join("; ");
      continue;
    }
    out[name] = value;
  }
  if (opts.upgrade) {
    out.connection = "Upgrade";
    if (req.headers.upgrade) out.upgrade = req.headers.upgrade;
  }

  const remote = req.socket.remoteAddress ?? "";
  const prior = req.headers["x-forwarded-for"];
  out["x-forwarded-for"] = prior ? `${String(prior)}, ${remote}` : remote;
  out["x-forwarded-proto"] = String(req.headers["x-forwarded-proto"] ?? scheme);
  out["x-forwarded-host"] = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
  return out;
}

/**
 * Only a same-site path is followed after the cookie is set. Anything else
 * -- another origin, a protocol-relative `//host`, a backslash trick -- would
 * make the auth endpoint an open redirect.
 */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

function notListening(port: number, err: NodeJS.ErrnoException): string {
  const why =
    err.code === "ECONNREFUSED"
      ? `Nothing is listening on port ${port} on this machine's loopback (127.0.0.1 or ::1).`
      : `The dev server on port ${port} could not be reached (${err.code ?? err.message}).`;
  return `${why} Start it in the project terminal, for example:<pre>php artisan serve --port=${port}\nnpm run dev -- --port ${port}\npython3 -m http.server ${port}</pre>Vite 6 and later also need <code>server.allowedHosts: true</code> so it accepts the preview hostname.`;
}

function sendHtml(res: ServerResponse, status: number, title: string, body: string): void {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1.5rem;color:#333}h1{font-size:1.25rem}pre{background:#f4f4f4;padding:.75rem 1rem;border-radius:6px;overflow-x:auto}code{background:#f4f4f4;padding:.1em .3em;border-radius:4px}</style><h1>${escape(title)}</h1><p>${body}</p>`;
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function rejectSocket(socket: Duplex, statusLine: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
