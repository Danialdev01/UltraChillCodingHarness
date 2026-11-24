import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkedAddresses, createHostFetch, isPrivateAddress, normalizeBaseUrl } from "./git-base-url.js";

let server: Server | undefined;
afterEach(() => server?.close());
const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<number>((done) => {
    server = createServer(handler!).listen(0, "127.0.0.1", () => done((server!.address() as AddressInfo).port));
  });

describe("normalizeBaseUrl", () => {
  it("lower-cases the host and drops the trailing slash", () => {
    expect(normalizeBaseUrl(" https://Git.Example.com/ ")).toBe("https://git.example.com");
    expect(normalizeBaseUrl("https://example.com:443/gitea/")).toBe("https://example.com/gitea");
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("refuses what is not a plain server address", () => {
    for (const raw of [
      "git.example.com",
      "ftp://example.com",
      "ssh://git@example.com",
      "https://user:pw@example.com",
      "https://example.com/?a=1",
      "https://example.com/#x",
      "https://example.com/a%2fb",
      "",
    ]) {
      expect(() => normalizeBaseUrl(raw), raw).toThrow();
    }
  });
});

describe("where a token may go", () => {
  it("knows a private address", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "172.32.0.1", "169.254.169.254", "2001:db8::1", "0.0.0.0", "fe80::1"]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });

  it("allows http only when every address is private, and https anywhere but link-local", async () => {
    const at = (url: string, ...addresses: string[]) => checkedAddresses(new URL(url), async () => addresses);
    await expect(at("http://git.lan", "10.0.0.1")).resolves.toEqual(["10.0.0.1"]);
    await expect(at("http://git.lan", "10.0.0.1", "8.8.8.8")).rejects.toThrow(/private network/);
    await expect(at("https://git.example.com", "8.8.8.8")).resolves.toEqual(["8.8.8.8"]);
    await expect(at("https://meta", "169.254.169.254")).rejects.toThrow(/link-local/);
    await expect(at("http://[fe80::1]")).rejects.toThrow(/link-local/);
  });
});

describe("hostFetch", () => {
  it("sends the request and reads the answer", async () => {
    const port = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.setHeader("x-total-count", "3").end(JSON.stringify({ auth: req.headers.authorization, body })));
    });
    const fetch = createHostFetch(async () => ["127.0.0.1"]);
    const res = await fetch(`http://git.lan:${port}/x`, { method: "POST", headers: { authorization: "token t" }, body: "héllo" });
    expect(await res.json()).toEqual({ auth: "token t", body: "héllo" });
    expect(res.headers.get("x-total-count")).toBe("3");
  });

  it("refuses a name that now answers with a public address", async () => {
    const answers = [["127.0.0.1"], ["8.8.8.8"]];
    const resolve = async () => answers.shift()!;
    await checkedAddresses(new URL("http://git.lan"), resolve);
    await expect(createHostFetch(resolve)("http://git.lan/x")).rejects.toThrow(/private network/);
  });

  it("does not follow a redirect", async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits++;
      res.writeHead(302, { location: "/elsewhere" }).end();
    });
    const res = await createHostFetch()(`http://127.0.0.1:${port}/x`);
    expect(res.status).toBe(302);
    expect(hits).toBe(1);
  });
});
