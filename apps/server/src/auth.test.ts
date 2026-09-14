import { describe, expect, it } from "vitest";
import { AuthService, DEV_USER_ID, type Principal } from "./auth.js";
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

describe("the profile the settings page reads back", () => {
  const bypass = loadConfig({
    DATABASE_URL: "postgres://localhost/test",
    DEV_AUTH_BYPASS: "true",
  } as NodeJS.ProcessEnv);

  /** Just enough drizzle to answer one `select ... limit 1`. */
  const dbReturning = (rows: unknown[]) =>
    ({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => rows }) }),
      }),
    }) as never;

  it("reads the stored row for the bypass user, not a hardcoded one", async () => {
    // The bug this pins: the bypass user was answered with fixed values, so
    // a picture or an email saved from the settings page was written to the
    // row and then never shown again -- the edit worked and looked broken.
    const stored = {
      login: "dev",
      name: "Local Developer",
      email: "me@example.com",
      avatarUrl: "data:image/webp;base64,AAAA",
    };
    const auth = new AuthService(dbReturning([stored]), bypass);

    expect(await auth.getProfile(DEV_USER_ID)).toEqual(stored);
  });

  it("still has an answer when the bypass row has not been inserted yet", async () => {
    // It is created at boot, but a profile read racing that must not 401 the
    // whole shell.
    const auth = new AuthService(dbReturning([]), bypass);

    expect(await auth.getProfile(DEV_USER_ID)).toMatchObject({ login: "dev", avatarUrl: null });
  });

  it("reports a missing user as missing when the bypass is off", async () => {
    const strict = loadConfig({
      DATABASE_URL: "postgres://localhost/test",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv);
    const auth = new AuthService(dbReturning([]), strict);

    expect(await auth.getProfile(DEV_USER_ID)).toBeNull();
  });
});
