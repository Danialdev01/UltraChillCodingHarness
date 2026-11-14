import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviders, forbiddenEnvFor, ompGuardHookSource } from "@ucch/providers";
import { FakeProcessHost, stdout } from "@ucch/providers/testing";
import { loadConfig } from "./config.js";
import { ProviderService } from "./providers.js";
import { terminalEnv } from "./terminals.js";

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
    fakeDb({ openrouter: null, ...row }).db,
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

  it("lay out the OMP directory, private, with its settings and the guard hook", async () => {
    const svc = service(new FakeProcessHost([]));
    const dir = svc.ensureCredsDir(USER, "omp");
    expect(dir).toBe(join(root, USER, "omp"));
    for (const sub of ["", "agent", "sessions", "run", "wt"]) {
      expect((await stat(join(dir, sub))).mode & 0o777, sub || "omp").toBe(0o700);
    }
    expect(await readFile(join(dir, "agent", "config.yml"), "utf8")).toContain("autoResume: false");
    expect(svc.ompGuardHook(USER)).toBe(join(dir, "agent", "ucch-guard.ts"));
    expect(await readFile(svc.ompGuardHook(USER), "utf8")).toBe(ompGuardHookSource());
  });

  // A server upgrade ships a new hook; the subject's copy must follow it,
  // or turns would run under the old rules.
  it("refresh the OMP guard hook and settings when they differ from the server's", async () => {
    const svc = service(new FakeProcessHost([]));
    const dir = svc.ensureCredsDir(USER, "omp");
    await writeFile(svc.ompGuardHook(USER), "export default function () {}\n");
    await writeFile(join(dir, "agent", "config.yml"), "autoResume: true\n");
    svc.ensureCredsDir(USER, "omp");
    expect(await readFile(svc.ompGuardHook(USER), "utf8")).toBe(ompGuardHookSource());
    expect(await readFile(join(dir, "agent", "config.yml"), "utf8")).toContain("autoResume: false");
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

  it("never carries a Claude token, not even one the server was started with", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-host");
    const svc = service(new FakeProcessHost([]));
    expect(svc.providerEnv(USER, "claude").CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(svc.providerEnv(USER, "codex").CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(svc.loginEnv(USER, "claude-login").CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    vi.unstubAllEnvs();
  });

  describe("for omp", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("holds exactly the terminal's environment plus OMP's own variables and the OpenRouter key", () => {
      const svc = service(new FakeProcessHost([]));
      const dir = join(root, USER, "omp");
      const expected: Record<string, string> = {};
      for (const [name, value] of Object.entries(terminalEnv())) if (value !== undefined) expected[name] = value;
      Object.assign(expected, {
        TERM: "dumb",
        CI: "1",
        PI_CODING_AGENT_DIR: join(dir, "agent"),
        OMP_WORKTREE_DIR: join(dir, "wt"),
        OMP_SKIP_SETUP: "1",
        PI_TASK_MAX_OUTPUT_BYTES: "65536",
        OPENROUTER_API_KEY: "sk-or-v1-test",
      });
      const env = svc.providerEnv(USER, "omp", { openrouterKey: "sk-or-v1-test" });
      expect(env).toEqual(expected);
      expect(forbiddenEnvFor("omp", env)).toBeNull();
    });

    // Not named like secrets, so the terminal keeps them; OMP would bill
    // Bedrock or send the headers, so its process must not.
    it("drops every credential OMP would read, even ones a terminal keeps", () => {
      vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA");
      vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-api-key: k");
      vi.stubEnv("PERPLEXITY_COOKIES", "c");
      const svc = service(new FakeProcessHost([]));
      expect(terminalEnv().AWS_ACCESS_KEY_ID).toBe("AKIA");
      const env = svc.providerEnv(USER, "omp", { openrouterKey: "sk-or-v1-test" });
      for (const name of ["AWS_ACCESS_KEY_ID", "ANTHROPIC_CUSTOM_HEADERS", "PERPLEXITY_COOKIES"]) {
        expect(env[name], name).toBeUndefined();
      }
      expect(forbiddenEnvFor("omp", env)).toBeNull();
    });

    it("names the turn's preset for the guard hook, and never one the server inherited", () => {
      vi.stubEnv("UCCH_OMP_PRESET", "documentation");
      const svc = service(new FakeProcessHost([]));
      expect(svc.providerEnv(USER, "omp", { openrouterKey: "k" }).UCCH_OMP_PRESET).toBeUndefined();
      const env = svc.providerEnv(USER, "omp", { openrouterKey: "k", ompPreset: "research" });
      expect(env.UCCH_OMP_PRESET).toBe("research");
      expect(forbiddenEnvFor("omp", env)).toBeNull();
    });

    it("still refuses the run when a credential reaches it", () => {
      // The billing rule as a test (todo rule 6): whatever builds the
      // environment, a variable OMP would bill makes the run refuse.
      const svc = service(new FakeProcessHost([]));
      const env = { ...svc.providerEnv(USER, "omp", { openrouterKey: "k", ompPreset: "research" }), ANTHROPIC_API_KEY: "sk-ant" };
      expect(forbiddenEnvFor("omp", env)).toBe("ANTHROPIC_API_KEY");
    });

    it("carries no OpenRouter key unless given one, and none of the CLIs' variables", () => {
      const svc = service(new FakeProcessHost([]));
      const env = svc.providerEnv(USER, "omp");
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.CODEX_HOME).toBeUndefined();
    });
  });

  it("gives a login terminal a real TERM and CODEX_HOME for codex", () => {
    const svc = service(new FakeProcessHost([]));
    const env = svc.loginEnv(USER, "codex-login");
    expect(env.CODEX_HOME).toBe(join(root, USER, "codex"));
    expect(env.TERM).toBe("xterm-256color");
    expect(env.CI).toBeUndefined();
  });

  it("resolves a run onto the CLI's own login, with no token of the server's", async () => {
    const svc = service(new FakeProcessHost([]));
    const { ctx } = await svc.resolve(USER, "claude");
    expect(ctx("/w").env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(ctx("/w").env.CLAUDE_CONFIG_DIR).toBe(join(root, USER, "claude"));
    expect(ctx("/w").cwd).toBe("/w");
  });
});

describe("health", () => {
  it("discovers Codex models per account and caches them only for that account", async () => {
    const host = new FakeProcessHost([
      { match: (a) => a[0] === "codex" && a[1] === "--version", lines: [stdout("codex 0.166.0")] },
      { match: (a) => a[0] === "codex" && a[1] === "login", lines: [stdout("Logged in using ChatGPT")] },
      { match: (a) => a[1] === "app-server", lines: [
        stdout('{"id":1,"result":{}}'),
        stdout(JSON.stringify({ id: 2, result: { data: [
          { model: "gpt-6-sol", displayName: "GPT-6 Sol", supportedReasoningEfforts: [
            { reasoningEffort: "low" }, { reasoningEffort: "medium" },
            { reasoningEffort: "high" }, { reasoningEffort: "xhigh" },
          ] },
          { model: "gpt-5.3-codex", displayName: "GPT-5.3 Codex" },
        ] } })),
      ] },
    ]);
    const svc = service(host);
    const first = await svc.health(USER);
    expect(first.codex.models.map((model) => model.id)).toEqual(["gpt-6-sol", "gpt-5.3-codex"]);
    expect(first.codex.models[0]?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    await svc.health(USER);
    expect(host.spawned.filter((s) => s.argv[1] === "app-server")).toHaveLength(1);
    const other = "22222222-2222-2222-2222-222222222222";
    await svc.health(other);
    const discoveries = host.spawned.filter((s) => s.argv[1] === "app-server");
    expect(discoveries).toHaveLength(2);
    expect(discoveries[0]!.env.CODEX_HOME).toBe(join(root, USER, "codex"));
    expect(discoveries[1]!.env.CODEX_HOME).toBe(join(root, other, "codex"));
  });

  it("keeps Codex usable with an explicit warning when discovery fails", async () => {
    const svc = service(new FakeProcessHost([
      { match: (a) => a[0] === "codex" && a[1] === "--version", lines: [stdout("codex 0.166.0")] },
      { match: (a) => a[0] === "codex" && a[1] === "login", lines: [stdout("Logged in using ChatGPT")] },
    ]));
    const { codex } = await svc.health(USER);
    expect(codex.authenticated).toBe(true);
    expect(codex.models.length).toBeGreaterThan(0);
    expect(codex.warnings).toContain("Could not refresh the model catalogue; showing fallback models.");
  });

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
  });

  it("masks the account and never repeats the email", async () => {
    const svc = service(new FakeProcessHost(scripts(true)));
    const cards = await svc.health(USER);
    expect(cards.claude.account).toBe("d***@x.io");
    expect(JSON.stringify(cards)).not.toContain("d@x.io");
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
  it("empties the directory, keeps it, and writes nothing to the database", async () => {
    const { db, updates } = fakeDb({ openrouter: null });
    const svc = new ProviderService(db, config(), new FakeProcessHost([]), createProviders({ claudeBin: "claude", codexBin: "codex" }));
    const dir = svc.ensureCredsDir(USER, "claude");
    await writeFile(join(dir, ".credentials.json"), "{}");
    await svc.signOut(USER, "claude");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    expect(updates).toEqual([]);
  });
});

describe("subscription accounts (profiles)", () => {
  const WORK = { id: "22222222-2222-2222-2222-222222222222", dirName: "claude-0a1b2c3d4e5f" };

  it("keep the Default account in the folder logins always used", () => {
    const svc = service(new FakeProcessHost([]));
    expect(svc.credsDir(USER, "claude")).toBe(join(root, USER, "claude"));
    expect(svc.credsDir(USER, "claude", { id: "x", dirName: "claude" })).toBe(join(root, USER, "claude"));
  });

  it("give a named account its own private folder beside the Default one", async () => {
    const svc = service(new FakeProcessHost([]));
    const dir = svc.ensureCredsDir(USER, "claude", WORK);
    expect(dir).toBe(join(root, USER, WORK.dirName));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(svc.providerEnv(USER, "claude", { profile: WORK }).CLAUDE_CONFIG_DIR).toBe(dir);
    expect(svc.loginEnv(USER, "claude-login", WORK).CLAUDE_CONFIG_DIR).toBe(dir);
    expect(svc.cliRunDir(USER, "claude", WORK)).toBe(join(dir, "run"));
  });

  it("never move OMP into an account folder", () => {
    const svc = service(new FakeProcessHost([]));
    expect(svc.credsDir(USER, "omp", WORK)).toBe(join(root, USER, "omp"));
  });

  it("sign out one account without touching the other", async () => {
    const svc = service(new FakeProcessHost([]));
    const work = svc.ensureCredsDir(USER, "claude", WORK);
    const personal = svc.ensureCredsDir(USER, "claude");
    await writeFile(join(work, ".credentials.json"), "{}");
    await writeFile(join(personal, ".credentials.json"), "{}");
    await svc.signOut(USER, "claude", WORK);
    expect(existsSync(join(work, ".credentials.json"))).toBe(false);
    expect(existsSync(join(personal, ".credentials.json"))).toBe(true);
  });

  it("remove a named account's folder, and refuse to remove the Default one", async () => {
    const svc = service(new FakeProcessHost([]));
    const work = svc.ensureCredsDir(USER, "claude", WORK);
    await svc.removeProfileDir(USER, "claude", WORK);
    expect(existsSync(work)).toBe(false);
    await expect(svc.removeProfileDir(USER, "claude", { id: "d", dirName: "claude" })).rejects.toThrow(/Default/);
  });

  it("keep each account's Claude usage reading apart", async () => {
    const svc = service(new FakeProcessHost([]));
    svc.quotas.record(USER, [{ id: "session", usedPercent: 40, resetsAt: null }], WORK);
    const work = await svc.quotas.get(USER, "claude", WORK);
    expect(work).toMatchObject({ status: "ok", windows: [{ usedPercent: 40 }] });
    svc.quotas.record(USER, [{ id: "session", usedPercent: 90, resetsAt: null }]);
    expect(await svc.quotas.get(USER, "claude", WORK)).toMatchObject({ windows: [{ usedPercent: 40 }] });
    expect(await svc.quotas.get(USER, "claude")).toMatchObject({ windows: [{ usedPercent: 90 }] });
    // Forgetting the subject forgets every account of it.
    svc.invalidate(USER);
    expect((await svc.quotas.get(USER, "claude", WORK)).status).not.toBe("ok");
  });
});
