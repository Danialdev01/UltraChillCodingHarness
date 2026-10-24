import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyRequest, WebProxy } from "./web-proxy.js";
import { registry } from "./metrics.js";

let upstream: Server;
let edge: Server;
let proxy: WebProxy;
let staticDir: string;
let release: () => void;

const port = (s: Server) => (s.address() as AddressInfo).port;

beforeEach(async () => {
  staticDir = await mkdtemp(join(tmpdir(), "ucch-static-"));
  await mkdir(join(staticDir, "chunks"));
  await writeFile(join(staticDir, "chunks", "app.js"), "console.log(1)");

  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => (unblock = resolve));
  release = unblock;
  upstream = createServer(async (req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<p>shell</p>");
      await blocked;
      res.end("<p>rest</p>");
      return;
    }
    if (req.url === "/cookies") {
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.end("ok");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, forwarded: req.headers["x-forwarded-for"] }));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));

  proxy = new WebProxy({ upstream: `http://127.0.0.1:${port(upstream)}`, staticDir });
  edge = createServer((req, res) => {
    if (!proxy.handleRequest(req, res)) {
      res.end("fastify");
    }
  });
  await new Promise<void>((r) => edge.listen(0, "127.0.0.1", r));
});

afterEach(async () => {
  release();
  proxy.close();
  await new Promise<void>((r) => edge.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
  await rm(staticDir, { recursive: true, force: true });
});

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port(edge)}${path}`, { headers });
}

describe("WebProxy", () => {
  it("leaves the API to Fastify", async () => {
    expect(await (await get("/api/me")).text()).toBe("fastify");
    expect(await (await get("/health")).text()).toBe("fastify");
    expect(await (await get("/metrics")).text()).toBe("fastify");
  });

  it("proxies the web app with the original host and a forwarded-for", async () => {
    // fetch will not send a custom Host; node:http will.
    const body = await new Promise<{ url: string; host: string; forwarded: string }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: port(edge), path: "/some/page?x=1", headers: { host: "app.example.com" } },
        (res) => {
          let text = "";
          res.on("data", (c: Buffer) => (text += c));
          res.on("end", () => resolve(JSON.parse(text)));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body).toMatchObject({ url: "/some/page?x=1", host: "app.example.com" });
    expect(body.forwarded).toContain("127.0.0.1");
  });

  it("streams: the first chunk arrives before the upstream finishes", async () => {
    const first = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: port(edge), path: "/stream" }, (res) => {
        res.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      });
      req.on("error", reject);
      req.end();
    });
    expect(first).toBe("<p>shell</p>");
  });

  it("passes every set-cookie through", async () => {
    const response = await get("/cookies");
    expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("serves the build's static files from disk, cached forever", async () => {
    const response = await get("/_next/static/chunks/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(await response.text()).toBe("console.log(1)");
    expect((await get("/_next/static/chunks/missing.js")).status).toBe(404);
    expect((await get("/_next/static/..%2f..%2fetc%2fpasswd")).status).toBe(404);
  });

  it("answers 502 when the web app is down", async () => {
    await new Promise<void>((r) => upstream.close(() => r()));
    upstream.closeAllConnections();
    proxy.close();
    proxy = new WebProxy({ upstream: `http://127.0.0.1:1`, staticDir });
    const response = await get("/");
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    upstream.listen(0); // so afterEach can close it
  });
});

describe("request classes", () => {
  it("tells page loads, router fetches, prefetches and assets apart", () => {
    expect(classifyRequest("/abc/project", "GET", { accept: "text/html,application/xhtml+xml" })).toBe("document");
    expect(classifyRequest("/abc/project", "GET", { "sec-fetch-dest": "document" })).toBe("document");
    expect(classifyRequest("/abc/project", "GET", { rsc: "1" })).toBe("rsc");
    expect(classifyRequest("/abc/project", "GET", { rsc: "1", "next-router-prefetch": "1" })).toBe("rsc_prefetch");
    expect(classifyRequest("/_next/static/chunks/app.js", "GET", {})).toBe("static");
    expect(classifyRequest("/file-icons/svg/ts.svg", "GET", { accept: "image/*" })).toBe("static");
    expect(classifyRequest("/abc/project", "POST", { "next-action": "x", accept: "text/x-component" })).toBe("other");
  });

  it("counts proxied requests by class and times the upstream", async () => {
    const count = async (kind: string) => {
      const match = (await registry.render()).match(new RegExp(`web_requests_total\\{class="${kind}"\\} (\\d+)`));
      return match ? Number(match[1]) : 0;
    };
    const before = await count("rsc_prefetch");
    await (await get("/x", { rsc: "1", "next-router-prefetch": "1" })).text();
    expect(await count("rsc_prefetch")).toBe(before + 1);
    expect(await registry.render()).toMatch(/web_upstream_seconds_count\{class="rsc_prefetch"\} [1-9]/);
  });
});
