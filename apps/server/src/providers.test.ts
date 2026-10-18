import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProviders } from "@ucch/providers";
import { FakeProcessHost, stdout } from "@ucch/providers/testing";
import { loadConfig } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { ProviderService } from "./providers.js";

const USER = "11111111-1111-1111-1111-111111111111";
const SECRET = "ab".repeat(32);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-creds-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A `users` row double: one user, the columns the service reads and writes. */
function fakeDb(row: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [row] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          updates.push(values);
          Object.assign(row, values);
        },
      }),
    }),
  };
  return { db: db as never, updates };
}

const config = (over: Record<string, string> = {}) =>
  loadConfig({
    DATABASE_URL: "postgres://u:p@localhost:5432/ucch",
    NODE_ENV: "test",
    DEV_AUTH_BYPASS: "true",
    CREDS_ROOT: root,
    SECRET_KEY: SECRET,
    ...over,
  });

const service = (host: FakeProcessHost, row: Record<string, unknown> = {}, over = {}) =>
  new ProviderService(
    fakeDb({ openrouter: null, token: null, issuedAt: null, ...row }).db,
    config(over),
    host,
    createProviders({ claudeBin: "claude", codexBin: "codex" }),
  );

describe("credential directories", () => {
  it("are per user, per provider, and private", async () => {
    const svc = service(new FakeProcessHost([]));
    const dir = svc.ensureCredsDir(USER, "claude");
    expect(dir).toBe(join(root, USER, "claude"));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("seed the codex file credential store once", async () => {
    const svc = service(new FakeProcessHost([]));
    const dir = svc.ensureCredsDir(USER, "codex");
    const config = join(dir, "config.toml");
    expect(await readFile(config, "utf8")).toContain('cli_auth_credentials_store = "file"');
    await writeFile(config, "# edited by hand\n");
    svc.ensureCredsDir(USER, "codex");
    expect(await readFile(config, "utf8")).toBe("# edited by hand\n");
  });
});

describe("the environment a provider gets", () => {
  it("points the CLI at the user's directory and carries no API key or harness secret", () => {
    const svc = service(new FakeProcessHost([]));
    const env = svc.providerEnv(USER, "claude");
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, USER, "claude"));
    expect(env.CODEX_HOME).toBeUndefined();
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "SECRET_KEY", "DATABASE_URL"]) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env.CI).toBe("1");
    expect(env.TERM).toBe("dumb");
  });

  it("carries the pasted token only when asked", () => {
    const svc = service(new FakeProcessHost([]));
    expect(svc.providerEnv(USER, "claude").CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(svc.providerEnv(USER, "claude", { token: "tok" }).CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(svc.providerEnv(USER, "codex", { token: "tok" }).CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("gives a login terminal a real TERM and CODEX_HOME for codex", () => {
    const svc = service(new FakeProcessHost([]));
    const env = svc.loginEnv(USER, "codex-login");
    expect(env.CODEX_HOME).toBe(join(root, USER, "codex"));
    expect(env.TERM).toBe("xterm-256color");
    expect(env.CI).toBeUndefined();
  });

  it("decrypts the stored token for a run, and only for a run", async () => {
    const host = new FakeProcessHost([]);
    const svc = service(host, { token: encryptSecret("tok-123", SECRET) });
    const { ctx } = await svc.resolve(USER, "claude");
    expect(ctx("/w").env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-123");
    expect(ctx("/w").cwd).toBe("/w");
  });
});

describe("health", () => {
  const scripts = (loggedIn: boolean) => [
    { match: (a: readonly string[]) => a[0] === "claude" && a[1] === "--version", lines: [stdout("2.1.270 (Claude Code)")] },
    { match: (a: readonly string[]) => a[0] === "claude" && a[1] === "-p", lines: [stdout("--permission-prompts")] },
    {
      match: (a: readonly string[]) => a[0] === "claude" && a[1] === "auth",
      lines: [stdout(JSON.stringify({ loggedIn, authMethod: "claude.ai", email: "d@x.io" }))],
    },
  ];

  it("returns three cards, with codex not installed and nothing thrown", async () => {
    const svc = service(new FakeProcessHost(scripts(false)));
    const cards = await svc.health(USER);
    expect(cards.native).toMatchObject({ id: "native", installed: true, authenticated: false });
    expect(cards.claude).toMatchObject({ installed: true, authenticated: false, authMode: "none", enabled: true });
    expect(cards.codex).toMatchObject({ installed: false, authenticated: false });
    expect(cards.claude.token).toEqual({ configured: false, issuedAt: null, expiresSoon: false });
  });

  it("masks the account and never repeats the email", async () => {
    const svc = service(new FakeProcessHost(scripts(true)));
    const cards = await svc.health(USER);
    expect(cards.claude.account).toBe("d***@x.io");
    expect(JSON.stringify(cards)).not.toContain("d@x.io");
  });

  it("warns about a token nearing the end of its year", async () => {
    const eleven = new Date(Date.now() - 340 * 24 * 3600_000);
    const svc = service(new FakeProcessHost(scripts(true)), {
      token: encryptSecret("tok", SECRET),
      issuedAt: eleven,
    });
    const cards = await svc.health(USER);
    expect(cards.claude.token).toMatchObject({ configured: true, expiresSoon: true });
    expect(cards.claude.authMode).toBe("token");
  });

  it("marks the CLI providers disabled in production without the shell flag", async () => {
    const svc = service(new FakeProcessHost(scripts(true)), {}, {
      NODE_ENV: "production",
      DEV_AUTH_BYPASS: "false",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "s",
    });
    const cards = await svc.health(USER);
    expect(cards.claude.enabled).toBe(false);
    expect(cards.native.enabled).toBe(true);
  });

  it("caches a probe and forgets it on invalidate", async () => {
    const host = new FakeProcessHost(scripts(false));
    const svc = service(host);
    await svc.health(USER);
    const spawnedOnce = host.spawned.length;
    await svc.health(USER);
    expect(host.spawned.length).toBe(spawnedOnce);
    svc.invalidate(USER);
    await svc.health(USER);
    expect(host.spawned.length).toBeGreaterThan(spawnedOnce);
  });
});

describe("sign out", () => {
  it("empties the directory, keeps it, and clears the stored token", async () => {
    const { db, updates } = fakeDb({ openrouter: null, token: "enc", issuedAt: new Date() });
    const svc = new ProviderService(db, config(), new FakeProcessHost([]), createProviders({ claudeBin: "claude", codexBin: "codex" }));
    const dir = svc.ensureCredsDir(USER, "claude");
    await writeFile(join(dir, ".credentials.json"), "{}");
    await svc.signOut(USER, "claude");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    expect(updates).toEqual([{ claudeOauthTokenEncrypted: null, claudeTokenIssuedAt: null }]);
  });
});
