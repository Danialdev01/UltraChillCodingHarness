import { describe, expect, it } from "vitest";
import { cliProvidersEnabled, loadConfig, logLevel, shellPluginEnabled, webOrigin } from "./config.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/ucch",
  NODE_ENV: "test",
  DEV_AUTH_BYPASS: "true",
};

const load = (over: Record<string, string> = {}) => loadConfig({ ...base, ...over });

describe("agent configuration", () => {
  it("caps the loop at 25 iterations unless told otherwise", () => {
    expect(load().AGENT_MAX_ITERATIONS).toBe(25);
    expect(load({ AGENT_MAX_ITERATIONS: "4" }).AGENT_MAX_ITERATIONS).toBe(4);
  });

  // A cap of zero would answer nothing; a fractional one is a typo.
  it("refuses a nonsensical cap rather than clamping it", () => {
    expect(() => load({ AGENT_MAX_ITERATIONS: "0" })).toThrow(/AGENT_MAX_ITERATIONS/);
    expect(() => load({ AGENT_MAX_ITERATIONS: "-1" })).toThrow(/AGENT_MAX_ITERATIONS/);
    expect(() => load({ AGENT_MAX_ITERATIONS: "2.5" })).toThrow(/AGENT_MAX_ITERATIONS/);
  });

  it("treats host shell access as off unless explicitly turned on", () => {
    expect(load().AGENT_ALLOW_HOST_SHELL).toBe(false);
    expect(load({ AGENT_ALLOW_HOST_SHELL: "yes" }).AGENT_ALLOW_HOST_SHELL).toBe(false);
    expect(load({ AGENT_ALLOW_HOST_SHELL: "true" }).AGENT_ALLOW_HOST_SHELL).toBe(true);
    expect(load({ AGENT_ALLOW_HOST_SHELL: "1" }).AGENT_ALLOW_HOST_SHELL).toBe(true);
  });
});

describe("shellPluginEnabled", () => {
  const production = {
    NODE_ENV: "production",
    DEV_AUTH_BYPASS: "false",
    GITHUB_CLIENT_ID: "id",
    GITHUB_CLIENT_SECRET: "secret",
  };

  it("loads the plugin in development without being asked", () => {
    expect(shellPluginEnabled(load())).toBe(true);
    expect(shellPluginEnabled(load({ NODE_ENV: "test" }))).toBe(true);
  });

  // In production the server holds the Docker socket, so bash on the host is
  // root on the host. It has to be chosen.
  it("refuses the plugin in production until the flag is set", () => {
    expect(shellPluginEnabled(load(production))).toBe(false);
    expect(shellPluginEnabled(load({ ...production, AGENT_ALLOW_HOST_SHELL: "true" }))).toBe(true);
  });
});

describe("provider configuration", () => {
  it("has a credential root and a per-user concurrency cap by default", () => {
    expect(load().CREDS_ROOT).toBe("/srv/ucch/creds");
    expect(load().AGENT_MAX_CONCURRENT_PER_USER).toBe(2);
    expect(load({ AGENT_MAX_CONCURRENT_PER_USER: "5" }).AGENT_MAX_CONCURRENT_PER_USER).toBe(5);
    expect(() => load({ AGENT_MAX_CONCURRENT_PER_USER: "0" })).toThrow(/CONCURRENT/);
  });

  it("caps the turns running on the whole server", () => {
    expect(load().AGENT_MAX_CONCURRENT_TOTAL).toBe(5);
    expect(load().AGENT_MAX_NATIVE_TOTAL).toBe(32);
    expect(load({ AGENT_MAX_CONCURRENT_TOTAL: "8" }).AGENT_MAX_CONCURRENT_TOTAL).toBe(8);
    expect(() => load({ AGENT_MAX_NATIVE_TOTAL: "0" })).toThrow(/NATIVE_TOTAL/);
  });

  it("talks to OpenRouter unless pointed at a mock", () => {
    expect(load().OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(load({ OPENROUTER_BASE_URL: "http://127.0.0.1:4010/api/v1/" }).OPENROUTER_BASE_URL).toBe(
      "http://127.0.0.1:4010/api/v1",
    );
    expect(() => load({ OPENROUTER_BASE_URL: "not a url" })).toThrow(/OPENROUTER_BASE_URL/);
  });

  it("resolves the CLIs through PATH unless pinned", () => {
    expect(load().CLAUDE_BIN).toBe("claude");
    expect(load({ CODEX_BIN: "/opt/codex/bin/codex" }).CODEX_BIN).toBe("/opt/codex/bin/codex");
  });

  // A CLI provider hands the model a host shell, which is what the shell
  // plugin is; one gate for both.
  it("follows the host-shell gate exactly", () => {
    const production = {
      NODE_ENV: "production",
      DEV_AUTH_BYPASS: "false",
      GITHUB_CLIENT_ID: "id",
      GITHUB_CLIENT_SECRET: "secret",
    };
    expect(cliProvidersEnabled(load())).toBe(true);
    expect(cliProvidersEnabled(load(production))).toBe(false);
    expect(cliProvidersEnabled(load({ ...production, AGENT_ALLOW_HOST_SHELL: "1" }))).toBe(true);
  });
});

describe("empty values", () => {
  it("treats a blank variable as unset rather than as a bad value", () => {
    const config = load({ DEFAULT_USER_EMAIL: "", DEFAULT_MODEL: "", PUBLIC_PREVIEW_PORT: "" });
    expect(config.DEFAULT_USER_EMAIL).toBeUndefined();
    expect(config.DEFAULT_MODEL).toBe("anthropic/claude-sonnet-4.5");
    expect(config.PUBLIC_PREVIEW_PORT).toBeUndefined();
  });
});

describe("preview configuration", () => {
  it("derives the web origin from the root domain unless told otherwise", () => {
    expect(webOrigin(load())).toBe("http://ucch.localhost");
    expect(webOrigin(load({ PUBLIC_WEB_ORIGIN: "http://localhost:3000" }))).toBe(
      "http://localhost:3000",
    );
    expect(() => load({ PUBLIC_WEB_ORIGIN: "not a url" })).toThrow(/PUBLIC_WEB_ORIGIN/);
  });

  it("leaves the preview port off unless set, and refuses a bad one", () => {
    expect(load().PUBLIC_PREVIEW_PORT).toBeUndefined();
    expect(load({ PUBLIC_PREVIEW_PORT: "3001" }).PUBLIC_PREVIEW_PORT).toBe(3001);
    expect(() => load({ PUBLIC_PREVIEW_PORT: "70000" })).toThrow(/PUBLIC_PREVIEW_PORT/);
  });
});

describe("DEV_AUTH_BYPASS", () => {
  it("is refused unless the environment says development or test", () => {
    const { NODE_ENV: _, ...withoutEnv } = base;
    expect(() => loadConfig(withoutEnv)).toThrow(/DEV_AUTH_BYPASS/);
    expect(() => load({ NODE_ENV: "production" })).toThrow(/DEV_AUTH_BYPASS/);
    expect(load({ NODE_ENV: "development" }).DEV_AUTH_BYPASS).toBe(true);
  });
});

describe("runtime settings", () => {
  it("opens 20 database connections unless told otherwise", () => {
    expect(load().DB_POOL_MAX).toBe(20);
    expect(load({ DB_POOL_MAX: "40" }).DB_POOL_MAX).toBe(40);
    expect(() => load({ DB_POOL_MAX: "4" })).toThrow(/DB_POOL_MAX/);
  });

  // Every command in flight can hold a connection; the routes need the rest.
  it("refuses more engine commands at once than the pool leaves room for", () => {
    expect(load({ DB_POOL_MAX: "12", ENGINE_MAX_PARALLEL: "8" }).ENGINE_MAX_PARALLEL).toBe(8);
    expect(() => load({ DB_POOL_MAX: "11", ENGINE_MAX_PARALLEL: "8" })).toThrow(/ENGINE_MAX_PARALLEL \(8\) must be at most DB_POOL_MAX - 4 \(7\)/);
    expect(() => load({ ENGINE_MAX_PARALLEL: "17" })).toThrow(/ENGINE_MAX_PARALLEL/);
  });

  it("starts children at OOM score 800 and nice 10, within the kernel's ranges", () => {
    expect(load().CHILD_OOM_ADJ).toBe(800);
    expect(load().CHILD_NICE).toBe(10);
    expect(() => load({ CHILD_OOM_ADJ: "1001" })).toThrow(/CHILD_OOM_ADJ/);
    expect(() => load({ CHILD_OOM_ADJ: "-100" })).toThrow(/CHILD_OOM_ADJ/);
    expect(() => load({ CHILD_NICE: "20" })).toThrow(/CHILD_NICE/);
  });

  it("logs at info in production and debug otherwise, unless told", () => {
    const production = { NODE_ENV: "production", DEV_AUTH_BYPASS: "false", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "s" };
    expect(logLevel(load(production))).toBe("info");
    expect(logLevel(load())).toBe("debug");
    expect(logLevel(load({ LOG_LEVEL: "warn" }))).toBe("warn");
    expect(() => load({ LOG_LEVEL: "loud" })).toThrow(/LOG_LEVEL/);
    expect(load().LOG_SLOW_MS).toBe(1000);
  });
});
