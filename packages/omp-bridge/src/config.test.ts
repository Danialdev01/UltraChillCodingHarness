import { describe, expect, it } from "vitest";
import { ompEnv, readBridgeConfig, refuseForeignCredentials } from "./config.js";

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
    });
  });

  it("falls back to omp on the PATH, the cwd and five minutes", () => {
    expect(readBridgeConfig({ UCCH_BRIDGE_MAX_SECONDS: "soon" }, "/here")).toEqual({
      ompBin: "omp",
      agentDir: null,
      overlay: null,
      openrouterKey: null,
      worktree: "/here",
      maxSeconds: 300,
    });
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
