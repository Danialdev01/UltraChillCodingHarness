import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { LoginThrottle } from "./login-throttle.js";

describe("LoginThrottle", () => {
  it("makes unknown addresses wait, never one the owner has signed in from", () => {
    let now = 0;
    const throttle = new LoginThrottle(() => now);
    throttle.succeeded("me@example.com", "198.51.100.1");
    for (let i = 0; i < 30; i++) {
      expect(throttle.retryAfter("me@example.com", `10.0.0.${i}`)).toBe(0);
      throttle.failed("me@example.com", `10.0.0.${i}`);
    }
    expect(throttle.retryAfter("ME@example.com ", "10.0.1.1")).toBe(900);
    expect(throttle.retryAfter("me@example.com", "198.51.100.1")).toBe(0);
    expect(throttle.retryAfter("other@example.com", "10.0.1.1")).toBe(0);
    now += 15 * 60_000;
    expect(throttle.retryAfter("me@example.com", "10.0.1.1")).toBe(0);
  });
});

describe("TRUSTED_PROXIES", () => {
  const ipSeen = async (remoteAddress: string, env: Record<string, string> = {}) => {
    const config = loadConfig({ DATABASE_URL: "postgres://localhost/t", NODE_ENV: "test", DEV_AUTH_BYPASS: "true", ...env } as NodeJS.ProcessEnv);
    const app = Fastify({ trustProxy: config.TRUSTED_PROXIES });
    app.get("/", (request) => request.ip);
    const { body } = await app.inject({ url: "/", remoteAddress, headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.7" } });
    await app.close();
    return body;
  };

  it("takes the client from a proxy on this machine or network, not from what the client claims", async () => {
    for (const proxy of ["127.0.0.1", "172.18.0.4", "10.0.1.9"]) expect(await ipSeen(proxy)).toBe("203.0.113.7");
  });

  it("ignores the header from anyone else", async () => {
    expect(await ipSeen("198.51.100.9")).toBe("198.51.100.9");
  });

  it("can trust a CDN's ranges, or nobody", async () => {
    expect(await ipSeen("127.0.0.1", { TRUSTED_PROXIES: "loopback, 203.0.113.0/24" })).toBe("9.9.9.9");
    expect(await ipSeen("127.0.0.1", { TRUSTED_PROXIES: "none" })).toBe("127.0.0.1");
  });
});
