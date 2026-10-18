import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Agent, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

/**
 * The single-container edge: this server owns the one public port, and what
 * is not the API is the web app's.
 *
 * In order, for a request that is not a preview host's (preview.ts runs
 * first):
 *
 *   /api/*, /health        Fastify, as before -- `handleRequest` says no
 *   /_next/static/*        the build's hashed files, straight from disk and
 *                          cached forever: their names change with their bytes
 *   everything else        streamed to Next on loopback
 *
 * The proxy streams both ways and buffers nothing, so React's streamed
 * Suspense boundaries arrive as they render. It is a plain `node:http` hop
 * rather than a Fastify route: the API's compression and hooks would only
 * get in the way of a response Next already compressed.
 *
 * Off unless `WEB_UPSTREAM` is set -- development keeps `next dev` on its own
 * port.
 */
export interface WebProxyOptions {
  /** Next's own server, e.g. `http://127.0.0.1:3100`. */
  upstream: string;
  /** The build's `.next/static`, served at `/_next/static`. Proxied when unset. */
  staticDir?: string;
  log?: { error(obj: object, msg: string): void };
}

/** Headers that describe one hop, not the message, and must not be forwarded. */
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

const TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Paths that are the API's, never the web app's. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/health" || pathname === "/api" || pathname.startsWith("/api/");
}

export class WebProxy {
  readonly #upstream: URL;
  readonly #staticDir: string | undefined;
  readonly #agent = new Agent({ keepAlive: true, maxSockets: 128, keepAliveMsecs: 30_000 });
  readonly #log: WebProxyOptions["log"];

  constructor(options: WebProxyOptions) {
    this.#upstream = new URL(options.upstream);
    this.#staticDir = options.staticDir ? normalize(options.staticDir) : undefined;
    this.#log = options.log;
  }

  /** True when this handled the request; false leaves it to Fastify. */
  handleRequest(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = (req.url ?? "/").split("?")[0]!;
    if (isApiPath(pathname)) return false;
    if (this.#staticDir && pathname.startsWith("/_next/static/") && (req.method === "GET" || req.method === "HEAD")) {
      void this.#serveStatic(pathname.slice("/_next/static/".length), req, res);
      return true;
    }
    this.#proxy(req, res);
    return true;
  }

  async #serveStatic(rest: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let relative: string;
    try {
      relative = decodeURIComponent(rest);
    } catch {
      return notFound(res);
    }
    const root = this.#staticDir!;
    const path = normalize(join(root, relative));
    if (!path.startsWith(root + sep)) return notFound(res);
    try {
      const info = await stat(path);
      if (!info.isFile()) return notFound(res);
      res.writeHead(200, {
        "content-type": TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": IMMUTABLE,
        "x-content-type-options": "nosniff",
      });
      if (req.method === "HEAD") return void res.end();
      createReadStream(path)
        .on("error", () => res.destroy())
        .pipe(res);
    } catch {
      notFound(res);
    }
  }

  #proxy(req: IncomingMessage, res: ServerResponse): void {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    const remote = req.socket.remoteAddress ?? "";
    const prior = req.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = prior ? `${prior}, ${remote}` : remote;
    headers["x-forwarded-proto"] ??= "http";
    if (req.headers.host) headers["x-forwarded-host"] ??= req.headers.host;

    const upstream = httpRequest(
      {
        host: this.#upstream.hostname,
        port: this.#upstream.port || 80,
        method: req.method,
        path: req.url,
        headers,
        agent: this.#agent,
      },
      (answer) => {
        const raw: string[] = [];
        for (let i = 0; i < answer.rawHeaders.length; i += 2) {
          if (HOP_BY_HOP.has(answer.rawHeaders[i]!.toLowerCase())) continue;
          raw.push(answer.rawHeaders[i]!, answer.rawHeaders[i + 1]!);
        }
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, raw);
        // Each chunk as it comes: a streamed page must not wait for its end.
        res.flushHeaders();
        answer.pipe(res);
        answer.on("error", () => res.destroy());
      },
    );

    upstream.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      this.#log?.error({ err: error }, "web upstream unreachable");
      res.writeHead(502, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(UNAVAILABLE);
    });
    // A visitor who leaves mid-response should not keep Next rendering for nobody.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  close(): void {
    this.#agent.destroy();
  }
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("not found");
}

const UNAVAILABLE = `<!doctype html><meta charset="utf-8"><title>Starting up</title>
<meta http-equiv="refresh" content="3">
<body style="font:16px system-ui;padding:3rem;color:#444">UCCH is starting up. This page will retry in a moment.</body>`;
