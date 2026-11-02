import { describe, expect, it } from "vitest";
import { ompEnv, readBridgeConfig, refuseForeignCredentials, withEnvFile } from "./config.js";

describe("readBridgeConfig", () => {
  it("reads solution §10.1's variables", () => {
    expect(
      readBridgeConfig(
        {
          UCCH_OMP_BIN: "/opt/omp",
          UCCH_OMP_AGENT_DIR: "/creds/u/omp/agent",
          UCCH_OMP_OVERLAY: "/creds/u/omp/run/t.bridge.yml",
          OPENROUTER_API_KEY: "sk-or-test",
          UCCH_WORKTREE: "/ws/p",
          UCCH_BRIDGE_MAX_SECONDS: "120",
          UCCH_OMP_MEMORY: "1",
          UCCH_OMP_WEB_SEARCH: "1",
          UCCH_OMP_TRUSTED: "1",
          UCCH_SCHEDULER_SOCK: "/creds/omp-scheduler.sock",
          UCCH_BRIDGE_TOKEN: "tok",
          UCCH_BRIDGE_MAX_CALLS: "3",
        },
        "/elsewhere",
      ),
    ).toEqual({
      ompBin: "/opt/omp",
      agentDir: "/creds/u/omp/agent",
      overlay: "/creds/u/omp/run/t.bridge.yml",
      openrouterKey: "sk-or-test",
      worktree: "/ws/p",
      maxSeconds: 120,
      memory: true,
      webSearch: true,
      trusted: true,
      schedulerSock: "/creds/omp-scheduler.sock",
      leaseToken: "tok",
      maxCalls: 3,
    });
  });

  it("falls back to omp on the PATH, the cwd, five minutes, no scheduler and twelve calls", () => {
    expect(readBridgeConfig({ UCCH_BRIDGE_MAX_SECONDS: "soon", UCCH_BRIDGE_MAX_CALLS: "many" }, "/here")).toEqual({
      ompBin: "omp",
      agentDir: null,
      overlay: null,
      openrouterKey: null,
      worktree: "/here",
      maxSeconds: 300,
      memory: false,
      webSearch: false,
      trusted: false,
      schedulerSock: null,
      leaseToken: null,
      maxCalls: 12,
    });
  });
});

describe("withEnvFile", () => {
  it("reads the turn's variables from the file, over the environment's", () => {
    const files: Record<string, string> = {
      "/run/t.bridge.json": JSON.stringify({ OPENROUTER_API_KEY: "sk-or-file", UCCH_BRIDGE_TOKEN: "tok", UCCH_OMP_TRUSTED: "0" }),
    };
    const env = withEnvFile({ PATH: "/bin", UCCH_BRIDGE_ENV_FILE: "/run/t.bridge.json", UCCH_OMP_TRUSTED: "1" }, (path) => files[path]!);
    expect(env).toEqual({
      PATH: "/bin",
      UCCH_BRIDGE_ENV_FILE: "/run/t.bridge.json",
      OPENROUTER_API_KEY: "sk-or-file",
      UCCH_BRIDGE_TOKEN: "tok",
      UCCH_OMP_TRUSTED: "0",
    });
    expect(readBridgeConfig(env)).toMatchObject({ openrouterKey: "sk-or-file", leaseToken: "tok", trusted: false });
  });

  it("is the environment as it is without the variable, and refuses a file it cannot use", () => {
    const env = { PATH: "/bin" };
    expect(withEnvFile(env, () => { throw new Error("unread"); })).toBe(env);
    const missing = () => {
      throw new Error("ENOENT");
    };
    expect(() => withEnvFile({ UCCH_BRIDGE_ENV_FILE: "/x" }, missing)).toThrow("UCCH_BRIDGE_ENV_FILE (/x) could not be read: ENOENT");
    for (const text of ["[]", '{"A":1}', "null", "not json"]) {
      expect(() => withEnvFile({ UCCH_BRIDGE_ENV_FILE: "/x" }, () => text)).toThrow(/UCCH_BRIDGE_ENV_FILE \(\/x\)/);
    }
  });
});

describe("ompEnv", () => {
  const config = readBridgeConfig({ UCCH_OMP_AGENT_DIR: "/creds/u/omp/agent", OPENROUTER_API_KEY: "sk-or-workspace" }, "/w");

  it("hands OMP the workspace's key and nothing else that bills", () => {
    const env = ompEnv(config, {
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "sk-ant-operator",
      AWS_ACCESS_KEY_ID: "AKIA",
      SOME_PROVIDER_API_KEY: "k",
      OPENROUTER_API_KEY: "sk-or-workspace",
      UCCH_OMP_OVERLAY: "/x.yml",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      TERM: "dumb",
      CI: "1",
      OMP_SKIP_SETUP: "1",
      PI_CODING_AGENT_DIR: "/creds/u/omp/agent",
      OPENROUTER_API_KEY: "sk-or-workspace",
    });
    expect(refuseForeignCredentials(env)).toBeNull();
  });
});

describe("refuseForeignCredentials", () => {
  it("refuses a run with any credential but the OpenRouter key", () => {
    for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "GEMINI_API_KEY", "NEW_PROVIDER_API_KEY"]) {
      expect(refuseForeignCredentials({ PATH: "/usr/bin", [name]: "x" })).toMatch(new RegExp(`refusing to start omp: ${name} is set`));
    }
    expect(refuseForeignCredentials({ PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or" })).toBeNull();
  });
});
