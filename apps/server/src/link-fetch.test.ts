import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchLink, findLinks, LinkError, nameFor, rewriteLink } from "./link-fetch.js";

let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><title>Hi</title><body><p>Hello</p></body></html>");
    } else if (req.url === "/gz") {
      res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
      res.end(gzipSync("compressed body"));
    } else if (req.url === "/hop") {
      res.writeHead(302, { location: "/page" });
      res.end();
    } else if (req.url === "/to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" });
      res.end();
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(5000));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
  base = `http://test.example:${port}`;
});

afterAll(() => new Promise<void>((done) => server.close(() => done())));

/** Lets the loopback test server through, and nothing else private. */
const local = {
  resolve: async () => ["127.0.0.1"],
  blocked: (address: string) => address !== "127.0.0.1",
};

describe("fetchLink", () => {
  it("refuses loopback and private addresses by default", async () => {
    await expect(fetchLink(`http://127.0.0.1:${port}/page`)).rejects.toThrow(/private or loopback/);
    await expect(fetchLink("http://10.0.0.1/")).rejects.toThrow(LinkError);
    // A public-looking name that resolves inward is refused at connect time.
    await expect(fetchLink(`${base}/page`, { resolve: async () => ["127.0.0.1"] })).rejects.toThrow(/resolves to 127\.0\.0\.1/);
  });

  it("refuses other schemes and embedded credentials", async () => {
    await expect(fetchLink("file:///etc/passwd")).rejects.toThrow(/only http and https/);
    await expect(fetchLink("http://user:pw@example.com/")).rejects.toThrow(/credentials/);
  });

  it("fetches a page, following redirects", async () => {
    const page = await fetchLink(`${base}/hop`, local);
    expect(page.finalUrl).toBe(`${base}/page`);
    expect(page.contentType).toBe("text/html");
    expect(page.bytes.toString()).toContain("Hello");
    expect(page.name).toBe("test-example-page.html");
  });

  it("checks every redirect hop again", async () => {
    await expect(fetchLink(`${base}/to-metadata`, local)).rejects.toThrow(/private or loopback/);
  });

  it("decompresses gzip", async () => {
    expect((await fetchLink(`${base}/gz`, local)).bytes.toString()).toBe("compressed body");
  });

  it("stops at the size limit and reports errors plainly", async () => {
    await expect(fetchLink(`${base}/big`, { ...local, maxBytes: 1000 })).rejects.toThrow(/larger than/);
    await expect(fetchLink(`${base}/missing`, local)).rejects.toThrow(/answered 404/);
  });
});

describe("findLinks", () => {
  it("finds links in prose, trims trailing punctuation, and deduplicates", () => {
    expect(findLinks("See https://a.dev/x. And (https://b.dev/y) or https://a.dev/x, ok")).toEqual([
      "https://a.dev/x",
      "https://b.dev/y",
    ]);
  });
});

describe("rewriteLink", () => {
  it("turns a GitHub file view into the raw file", () => {
    expect(rewriteLink(new URL("https://github.com/o/r/blob/main/src/a.ts")).href).toBe(
      "https://raw.githubusercontent.com/o/r/main/src/a.ts",
    );
    expect(rewriteLink(new URL("https://github.com/o/r")).href).toBe("https://github.com/o/r");
  });
});

describe("nameFor", () => {
  it("keeps a real filename and invents one for a page", () => {
    expect(nameFor(new URL("https://x.org/files/report.pdf"), "application/pdf")).toBe("report.pdf");
    expect(nameFor(new URL("https://www.x.org/blog/post/"), "text/html")).toBe("x-org-blog-post.html");
    expect(nameFor(new URL("https://x.org/download?id=3"), "application/pdf")).toBe("x-org-download.pdf");
  });
});
