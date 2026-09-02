import { describe, expect, it } from "vitest";
import { AuthService, type Principal } from "./auth.js";
import { loadConfig, type Config } from "./config.js";

/**
 * Ticket semantics are tested with the bypass OFF -- that is the only mode
 * where they carry any weight. `DEV_AUTH_BYPASS` deliberately accepts any
 * ticket, and `loadConfig` refuses to enable it in production.
 */
const config = loadConfig({
  DATABASE_URL: "postgres://localhost/test",
  GITHUB_CLIENT_ID: "id",
  GITHUB_CLIENT_SECRET: "secret",
} as NodeJS.ProcessEnv);

// Ticket issuance and redemption are in-memory, so the database is never
// touched by these paths.
const auth = new AuthService(null as never, config);

const principal: Principal = {
  userId: "00000000-0000-4000-8000-000000000001",
  sessionId: "s1",
  scopes: ["read", "write"],
};

describe("websocket tickets", () => {
  it("redeems a valid ticket once", () => {
    const { ticket } = auth.issueTicket(principal);
    expect(auth.redeemTicket(ticket)).toEqual(principal);
    // Single-use: a replayed ticket from a proxy log is worthless.
    expect(auth.redeemTicket(ticket)).toBeNull();
  });

  it("rejects a forged or missing ticket", () => {
    expect(auth.redeemTicket("forged")).toBeNull();
    expect(auth.redeemTicket(undefined)).toBeNull();
  });

  it("issues distinct tickets", () => {
    expect(auth.issueTicket(principal).ticket).not.toBe(auth.issueTicket(principal).ticket);
  });
});

describe("configuration guards", () => {
  it("refuses the auth bypass in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://localhost/test",
        DEV_AUTH_BYPASS: "true",
      } as NodeJS.ProcessEnv),
    ).toThrow(/must not be enabled in production/);
  });

  it("requires GitHub credentials unless the bypass is on", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://localhost/test" } as NodeJS.ProcessEnv),
    ).toThrow(/GITHUB_CLIENT_ID/);

    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        DEV_AUTH_BYPASS: "true",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("rejects a malformed DATABASE_URL", () => {
    expect(() => loadConfig({ DATABASE_URL: "not-a-url" } as NodeJS.ProcessEnv)).toThrow(/invalid configuration/);
  });
});

describe("bypass mode", () => {
  const bypass = loadConfig({
    DATABASE_URL: "postgres://localhost/test",
    DEV_AUTH_BYPASS: "true",
  } as NodeJS.ProcessEnv);
  const open = new AuthService(null as never, bypass);

  it("authenticates any ticket as the dev user, by design", () => {
    // This is the point of the bypass, and why production refuses it.
    expect(open.redeemTicket("anything")?.scopes).toContain("admin");
  });
});
