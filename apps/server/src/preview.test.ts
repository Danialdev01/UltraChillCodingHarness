import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathError, WorkspaceFiles } from "./files.js";
import { PREVIEW_COOKIE, PreviewGateway, safeNext, staticMediaType, type PreviewProject } from "./preview.js";

const ROOT = "ucch.localhost";
const HASH = "a1b2c3d4e5f6";
const OTHER = "ffffffffffff";
const WEB = "http://localhost:3000";

/** A stand-in dev server: echoes what it received, and echoes WebSocket frames. */
function devServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-dev": "yes" });
      res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body }));
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`echo:${m}`)));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port })),
  );
}

interface Response {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
}

function send(
  gatewayPort: number,
  opts: { host: string; path?: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        path: opts.path ?? "/",
        method: opts.method ?? "GET",
        headers: { host: opts.host, ...opts.headers },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("PreviewGateway", () => {
  let dev: { server: Server; port: number };
  let gw: Server;
  let gwPort: number;
  let gateway: PreviewGateway;
  let now = 1_000_000;
  const projects = new Map<string, PreviewProject>();
  let resolves = 0;

  const previewHost = () => `p${dev.port}-${HASH}.${ROOT}`;
  const fallthrough: string[] = [];
  let workspaceRoot: string;

  beforeAll(async () => {
    dev = await devServer();
    workspaceRoot = await mkdtemp(join(tmpdir(), "ucch-preview-"));
    const site = join(workspaceRoot, "proj-1");
    await mkdir(join(site, "dist", "docs"), { recursive: true });
    await mkdir(join(site, ".git"), { recursive: true });
    await writeFile(join(site, "dist", "index.html"), "<h1>home</h1>");
    await writeFile(join(site, "dist", "about.html"), "<h1>about</h1>");
    await writeFile(join(site, "dist", "app.css"), "body{}");
    await writeFile(join(site, "dist", "docs", "index.html"), "<h1>docs</h1>");
    await writeFile(join(site, "secret.txt"), "outside the site");
    await writeFile(join(site, ".git", "config"), "[core]");
    const files = new WorkspaceFiles(workspaceRoot);
    projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: dev.port });
    projects.set(OTHER, { id: "proj-2", userId: "user-2", previewPort: 1 });

    gateway = new PreviewGateway({
      rootDomain: ROOT,
      scheme: "http",
      webOrigin: WEB,
      secret: "0".repeat(64),
      resolve: async (hash) => {
        resolves += 1;
        return projects.get(hash) ?? null;
      },
      target: (_p, port) => ({ hosts: ["127.0.0.1", "::1"], port }),
      readStatic: async (project, path) => {
        try {
          const file = await files.readBytes(project.id, path);
          return file.kind === "too_large" ? { kind: "missing" } : file;
        } catch (error) {
          if (error instanceof PathError) return { kind: "missing" };
          throw error;
        }
      },
      log: { error: () => {} },
      now: () => now,
    });

    gw = createServer((req, res) => {
      if (gateway.handleRequest(req, res)) return;
      fallthrough.push(req.headers.host ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("fastify");
    });
    gw.on("upgrade", (req, socket, head) => {
      if (gateway.handleUpgrade(req, socket, head)) return;
      socket.destroy();
    });
    await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
    gwPort = (gw.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => gw.close(r));
    await new Promise((r) => dev.server.close(r));
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  /** Runs the ticket handoff and returns the cookie value the preview host set. */
  async function login(): Promise<string> {
    const ticket = gateway.issueTicket({ projectId: "proj-1", userId: "user-1", port: dev.port });
    const res = await send(gwPort, { host: previewHost(), path: `/__ucch/auth?t=${ticket}&next=%2Fdashboard` });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/dashboard");
    const setCookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toMatch(new RegExp(`^${PREVIEW_COOKIE}=.*HttpOnly; SameSite=Lax$`));
    return setCookie.split(";")[0]!;
  }

  it("leaves non-project hosts to the application", async () => {
    const res = await send(gwPort, { host: `api.${ROOT}`, path: "/health" });
    expect(res.body).toBe("fastify");
    expect(fallthrough).toContain(`api.${ROOT}`);
  });

  it("sends a visitor without a cookie back through the alias, keeping the path", async () => {
    const res = await send(gwPort, { host: previewHost(), path: "/dashboard?tab=2" });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${WEB}/${HASH}/preview/dashboard?tab=2`);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("collapses the root path to the bare alias", async () => {
    const res = await send(gwPort, { host: previewHost(), path: "/" });
    expect(res.headers.location).toBe(`${WEB}/${HASH}/preview`);
  });

  it("refuses a hostname whose port is not the project's", async () => {
    const res = await send(gwPort, { host: `p${dev.port + 1}-${HASH}.${ROOT}` });
    expect(res.status).toBe(404);
    expect(res.body).toContain("No preview here");
  });

  it("refuses an unknown project", async () => {
    const res = await send(gwPort, { host: `p8001-bbbbbbbbbbbb.${ROOT}` });
    expect(res.status).toBe(404);
  });

  it("swaps a ticket for a cookie exactly once", async () => {
    const ticket = gateway.issueTicket({ projectId: "proj-1", userId: "user-1", port: dev.port });
    const first = await send(gwPort, { host: previewHost(), path: `/__ucch/auth?t=${ticket}` });
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe("/");
    const replay = await send(gwPort, { host: previewHost(), path: `/__ucch/auth?t=${ticket}` });
    expect(replay.status).toBe(403);
  });

  it("refuses an expired ticket", async () => {
    const ticket = gateway.issueTicket({ projectId: "proj-1", userId: "user-1", port: dev.port });
    now += 61_000;
    const res = await send(gwPort, { host: previewHost(), path: `/__ucch/auth?t=${ticket}` });
    expect(res.status).toBe(403);
  });

  it("refuses a ticket issued for another project or port", async () => {
    const wrongProject = gateway.issueTicket({ projectId: "proj-2", userId: "user-2", port: dev.port });
    expect((await send(gwPort, { host: previewHost(), path: `/__ucch/auth?t=${wrongProject}` })).status).toBe(403);
    const wrongPort = gateway.issueTicket({ projectId: "proj-1", userId: "user-1", port: dev.port + 1 });
    expect((await send(gwPort, { host: previewHost(), path: `/__ucch/auth?t=${wrongPort}` })).status).toBe(403);
  });

  it("proxies a request with a valid cookie, forwarding headers but not harness cookies", async () => {
    const cookie = await login();
    const res = await send(gwPort, {
      host: previewHost(),
      path: "/api/things?x=1",
      method: "POST",
      headers: { cookie: `${cookie}; ucch_session=secret; laravel_session=abc`, "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(200);
    expect(res.headers["x-dev"]).toBe("yes");
    const echoed = JSON.parse(res.body) as { url: string; method: string; body: string; headers: Record<string, string> };
    expect(echoed.url).toBe("/api/things?x=1");
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe("hello");
    expect(echoed.headers.host).toBe(previewHost());
    expect(echoed.headers.cookie).toBe("laravel_session=abc");
    expect(echoed.headers["x-forwarded-proto"]).toBe("http");
    expect(echoed.headers["x-forwarded-host"]).toBe(previewHost());
    expect(echoed.headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  it("drops a cookie that has been tampered with", async () => {
    const cookie = await login();
    const [name, value] = cookie.split("=") as [string, string];
    const [payload, sig] = value.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ p: "proj-2", n: dev.port, exp: now + 10_000 })).toString("base64url");
    for (const bad of [`${forged}.${sig}`, `${payload}.${sig.slice(1)}x`, payload, "nonsense"]) {
      const res = await send(gwPort, { host: previewHost(), headers: { cookie: `${name}=${bad}` } });
      expect(res.status).toBe(302);
    }
  });

  it("drops a cookie past its expiry", async () => {
    const cookie = await login();
    now += 13 * 60 * 60 * 1000;
    const res = await send(gwPort, { host: previewHost(), headers: { cookie } });
    expect(res.status).toBe(302);
  });

  it("answers a friendly 502 when nothing is listening", async () => {
    const closed = await devServer();
    const port = closed.port;
    await new Promise((r) => closed.server.close(r));
    projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: port });
    gateway.invalidate(HASH);
    try {
      const cookie = (await (async () => {
        const ticket = gateway.issueTicket({ projectId: "proj-1", userId: "user-1", port });
        const res = await send(gwPort, { host: `p${port}-${HASH}.${ROOT}`, path: `/__ucch/auth?t=${ticket}` });
        return res.headers["set-cookie"]![0]!.split(";")[0]!;
      })());
      const res = await send(gwPort, { host: `p${port}-${HASH}.${ROOT}`, headers: { cookie } });
      expect(res.status).toBe(502);
      expect(res.body).toContain(`Nothing is listening on port ${port}`);
      expect(res.body).toContain(`--port=${port}`);
    } finally {
      projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: dev.port });
      gateway.invalidate(HASH);
    }
  });

  it("caches the project lookup briefly and forgets it on invalidate", async () => {
    gateway.invalidate(HASH);
    const before = resolves;
    await send(gwPort, { host: previewHost() });
    await send(gwPort, { host: previewHost() });
    expect(resolves - before).toBe(1);
    gateway.invalidate(HASH);
    await send(gwPort, { host: previewHost() });
    expect(resolves - before).toBe(2);
  });

  it("proxies a WebSocket upgrade with a valid cookie", async () => {
    const cookie = await login();
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/hmr`, {
      headers: { host: previewHost(), cookie },
    });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (m) => resolve(String(m)));
      ws.on("error", reject);
    });
    expect(reply).toBe("echo:ping");
    ws.close();
  });

  it("refuses a WebSocket upgrade without a cookie", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/hmr`, { headers: { host: previewHost() } });
    const err = await new Promise<Error>((resolve) => ws.on("error", resolve));
    expect(err.message).toMatch(/401/);
  });

  it("reports whether a port is listening", async () => {
    expect(await PreviewGateway.probe(dev.port, "127.0.0.1")).toBe(true);
    const closed = await devServer();
    await new Promise((r) => closed.server.close(r));
    expect(await PreviewGateway.probe(closed.port, "127.0.0.1")).toBe(false);
    expect(await PreviewGateway.reachable(["127.0.0.1", "::1"], closed.port)).toBeNull();
  });

  // Vite binds `::1` by default; `php artisan serve` binds `127.0.0.1`. The
  // proxy has to find either without being told which.
  it("reaches a dev server bound only to IPv6 loopback", async () => {
    const v6 = createServer((_req, res) => res.end("v6"));
    await new Promise<void>((r) => v6.listen(0, "::1", r));
    const port = (v6.address() as AddressInfo).port;
    projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: port });
    gateway.invalidate(HASH);
    try {
      const ticket = gateway.issueTicket({ projectId: "proj-1", userId: "user-1", port });
      const auth = await send(gwPort, { host: `p${port}-${HASH}.${ROOT}`, path: `/__ucch/auth?t=${ticket}` });
      const cookie = auth.headers["set-cookie"]![0]!.split(";")[0]!;
      const res = await send(gwPort, { host: `p${port}-${HASH}.${ROOT}`, headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.body).toBe("v6");
      expect(await PreviewGateway.reachable(["127.0.0.1", "::1"], port)).toBe("::1");
    } finally {
      projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: dev.port });
      gateway.invalidate(HASH);
      await new Promise((r) => v6.close(r));
    }
  });

  describe("a static site", () => {
    const STATIC_PORT = 8080;
    const staticHost = `p${STATIC_PORT}-${HASH}.${ROOT}`;
    let cookie: string;

    beforeAll(async () => {
      projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: STATIC_PORT, previewStaticDir: "dist" });
      gateway.invalidate(HASH);
      const ticket = gateway.issueTicket({ projectId: "proj-1", userId: "user-1", port: STATIC_PORT });
      const auth = await send(gwPort, { host: staticHost, path: `/__ucch/auth?t=${ticket}` });
      cookie = auth.headers["set-cookie"]![0]!.split(";")[0]!;
    });

    afterAll(() => {
      projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: dev.port });
      gateway.invalidate(HASH);
    });

    const get = (path: string, method = "GET") => send(gwPort, { host: staticHost, path, method, headers: { cookie } });

    it("still needs the preview cookie", async () => {
      const res = await send(gwPort, { host: staticHost, path: "/" });
      expect(res.status).toBe(302);
    });

    it("serves the folder's index.html at the root, as HTML", async () => {
      const res = await get("/");
      expect(res.status).toBe(200);
      expect(res.body).toBe("<h1>home</h1>");
      expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res.headers["cache-control"]).toBe("no-cache");
    });

    it("serves assets by extension, and clean URLs from .html", async () => {
      const css = await get("/app.css");
      expect(css.body).toBe("body{}");
      expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
      expect((await get("/about")).body).toBe("<h1>about</h1>");
    });

    it("redirects a folder to its trailing slash, then serves its index", async () => {
      const res = await get("/docs?x=1");
      expect(res.status).toBe(301);
      expect(res.headers.location).toBe("/docs/?x=1");
      expect((await get("/docs/")).body).toBe("<h1>docs</h1>");
    });

    it("answers HEAD without a body", async () => {
      const res = await get("/", "HEAD");
      expect(res.status).toBe(200);
      expect(res.body).toBe("");
      expect(res.headers["content-length"]).toBe("13");
    });

    it("refuses writes, missing files, and anything outside the folder", async () => {
      expect((await get("/", "POST")).status).toBe(405);
      expect((await get("/nope.html")).status).toBe(404);
      expect((await get("/%2e%2e/secret.txt")).body).not.toContain("outside");
      expect((await get("/..%2fsecret.txt")).status).toBe(400);
      expect((await get("/../secret.txt")).body).not.toContain("outside");
    });

    it("keeps .git out of a site served from the root", async () => {
      projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: STATIC_PORT, previewStaticDir: "" });
      gateway.invalidate(HASH);
      try {
        expect((await get("/secret.txt")).body).toBe("outside the site");
        expect((await get("/.git/config")).status).toBe(404);
      } finally {
        projects.set(HASH, { id: "proj-1", userId: "user-1", previewPort: STATIC_PORT, previewStaticDir: "dist" });
        gateway.invalidate(HASH);
      }
    });

    it("reports whether there is an index to show", async () => {
      expect(await gateway.hasStaticIndex({ id: "proj-1", userId: "", previewPort: STATIC_PORT, previewStaticDir: "dist" })).toBe(true);
      expect(await gateway.hasStaticIndex({ id: "proj-1", userId: "", previewPort: STATIC_PORT, previewStaticDir: "" })).toBe(false);
    });

    it("refuses a WebSocket upgrade", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${gwPort}/hmr`, { headers: { host: staticHost, cookie } });
      const err = await new Promise<Error>((resolve) => ws.on("error", resolve));
      expect(err.message).toMatch(/404/);
    });
  });
});

describe("staticMediaType", () => {
  it("types web files by extension and downloads the rest", () => {
    expect(staticMediaType("a/b.JS")).toBe("text/javascript; charset=utf-8");
    expect(staticMediaType("logo.svg")).toBe("image/svg+xml");
    expect(staticMediaType("archive.tar.gz")).toBe("application/octet-stream");
    expect(staticMediaType("Makefile")).toBe("application/octet-stream");
  });
});

describe("safeNext", () => {
  it("keeps same-site paths and nothing else", () => {
    expect(safeNext("/dashboard?x=1")).toBe("/dashboard?x=1");
    expect(safeNext(null)).toBe("/");
    expect(safeNext("")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("dashboard")).toBe("/");
  });
});
