import { createHash } from "node:crypto";
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

/** A database holding `live` sessions, and nothing else. */
const live = new Map<string, Date>();
const sessionDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [...live].map(([id, expiresAt]) => ({ id, userId: principal.userId, scopes: principal.scopes, expiresAt })),
      }),
    }),
  }),
  delete: () => ({
    where: () => {
      const gone = [...live.keys()].map((id) => ({ id }));
      live.clear();
      return Object.assign(Promise.resolve(), { returning: async () => gone });
    },
  }),
};
const auth = new AuthService(sessionDb as never, config);

const principal: Principal = {
  userId: "00000000-0000-4000-8000-000000000001",
  sessionId: "s1",
  scopes: ["read", "write"],
};
const later = () => new Date(Date.now() + 60_000);

describe("websocket tickets", () => {
  it("redeems a valid ticket once", async () => {
    live.set("s1", later());
    const { ticket } = auth.issueTicket(principal);
    expect(await auth.redeemTicket(ticket)).toEqual(principal);
    // Single-use: a replayed ticket from a proxy log is worthless.
    expect(await auth.redeemTicket(ticket)).toBeNull();
  });

  it("rejects a forged or missing ticket", async () => {
    expect(await auth.redeemTicket("forged")).toBeNull();
    expect(await auth.redeemTicket(undefined)).toBeNull();
  });

  it("issues distinct tickets", () => {
    expect(auth.issueTicket(principal).ticket).not.toBe(auth.issueTicket(principal).ticket);
  });

  it("is worthless once its session is signed out, and says the session ended", async () => {
    const ended: string[] = [];
    auth.onSessionsEnded((ids) => ended.push(...ids));
    const sessionId = createHash("sha256").update("token").digest("hex");
    live.clear();
    live.set(sessionId, later());
    expect((await auth.resolveSession("token"))?.sessionId).toBe(sessionId);
    const { ticket } = auth.issueTicket({ ...principal, sessionId });
    await auth.revokeSession("token");
    expect(await auth.redeemTicket(ticket)).toBeNull();
    expect(await auth.sessionActive(sessionId)).toBe(false);
    expect(ended).toEqual([sessionId]);
  });

  it("is worthless once its session has expired", async () => {
    live.clear();
    const { ticket } = auth.issueTicket({ ...principal, sessionId: "s9" });
    live.set("s9", new Date(Date.now() - 1000));
    expect(await auth.redeemTicket(ticket)).toBeNull();
  });

  it("does not bring back a session that ended while it was being read", async () => {
    live.clear();
    const id = createHash("sha256").update("racing").digest("hex");
    live.set(id, later());
    const reading = auth.resolveSession("racing");
    await auth.revokeSession("racing");
    await reading;
    expect(await auth.sessionActive(id)).toBe(false);
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
    ).toThrow(/DEV_AUTH_BYPASS is only allowed/);
  });

  it("requires GitHub credentials unless the bypass is on", () => {
    expect(() =>
      loadConfig({ DATABASE_URL: "postgres://localhost/test" } as NodeJS.ProcessEnv),
    ).toThrow(/GITHUB_CLIENT_ID/);

    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/test",
        NODE_ENV: "test",
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
    NODE_ENV: "test",
    DEV_AUTH_BYPASS: "true",
  } as NodeJS.ProcessEnv);
  const open = new AuthService(null as never, bypass);

  it("authenticates any ticket as the dev user, by design", async () => {
    // This is the point of the bypass, and why production refuses it.
    expect((await open.redeemTicket("anything"))?.scopes).toContain("admin");
  });
});

describe("the profile the settings page reads back", () => {
  const bypass = loadConfig({
    DATABASE_URL: "postgres://localhost/test",
    NODE_ENV: "test",
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

describe("the session cache", () => {
  const row = {
    id: "",
    userId: "00000000-0000-4000-8000-000000000001",
    scopes: ["read"],
    expiresAt: new Date(Date.now() + 60_000),
  };

  /** Counts selects, and answers them with `row` until it has been deleted. */
  function countingDb() {
    let selects = 0;
    let present = true;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selects++;
              return present ? [row] : [];
            },
          }),
        }),
      }),
      delete: () => ({
        where: async () => {
          present = false;
        },
      }),
    };
    return { db: db as never, selects: () => selects };
  }

  it("resolves a session from Postgres once, then from memory", async () => {
    const { db, selects } = countingDb();
    const cached = new AuthService(db, config);
    expect(await cached.resolveSession("token")).toMatchObject({ userId: row.userId });
    expect(await cached.resolveSession("token")).toMatchObject({ userId: row.userId });
    expect(selects()).toBe(1);
  });

  it("forgets a revoked session immediately", async () => {
    const { db } = countingDb();
    const cached = new AuthService(db, config);
    await cached.resolveSession("token");
    await cached.revokeSession("token");
    expect(await cached.resolveSession("token")).toBeNull();
  });
});
