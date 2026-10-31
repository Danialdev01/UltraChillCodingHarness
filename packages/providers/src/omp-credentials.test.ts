import { describe, expect, it } from "vitest";
import { OMP_CREDENTIAL_ENV, isOmpCredentialEnv } from "./omp-credentials.js";
import { runCli, type Normaliser } from "./run.js";
import { FakeProcessHost } from "./testing.js";
import { ALLOWED_CREDENTIAL_ENV, forbiddenEnvFor } from "./types.js";

// A normaliser that never sees a line: these runs must not get that far.
const inert: Normaliser = { push: () => [], finish: () => [] };

function ompRun(env: Record<string, string>, host = new FakeProcessHost([])) {
  return runCli({ provider: "omp", ctx: { cwd: "/w", env, host }, spec: { argv: ["omp"] }, normaliser: inert });
}

describe("OMP credential variables", () => {
  it("lists the keys that would bill someone else", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "OPENAI_CODEX_OAUTH_TOKEN",
      "GEMINI_API_KEY",
      "XAI_API_KEY",
    ]) {
      expect(OMP_CREDENTIAL_ENV).toContain(name);
    }
  });

  // OMP derives some providers' variable names from their ids, so a
  // provider added after this list was written still counts.
  it("treats any API key or OAuth token as a credential, listed or not", () => {
    expect(isOmpCredentialEnv("SOMENEWVENDOR_API_KEY")).toBe(true);
    expect(isOmpCredentialEnv("SOMENEWVENDOR_OAUTH_TOKEN")).toBe(true);
    expect(isOmpCredentialEnv("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isOmpCredentialEnv("PATH")).toBe(false);
    expect(isOmpCredentialEnv("PI_CODING_AGENT_DIR")).toBe(false);
  });
});

describe("forbiddenEnvFor", () => {
  it("allows exactly the OpenRouter key for omp, and nothing for the CLIs", () => {
    expect(ALLOWED_CREDENTIAL_ENV).toEqual({ claude: [], codex: [], omp: ["OPENROUTER_API_KEY"] });
    expect(forbiddenEnvFor("omp", { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-x" })).toBeNull();
  });

  it.each(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "OPENAI_CODEX_OAUTH_TOKEN", "GEMINI_API_KEY"])(
    "makes an omp run refuse with %s present, before anything is spawned",
    (name) => {
      const host = new FakeProcessHost([]);
      expect(forbiddenEnvFor("omp", { OPENROUTER_API_KEY: "sk-or-x", [name]: "x" })).toBe(name);
      expect(() => ompRun({ OPENROUTER_API_KEY: "sk-or-x", [name]: "x" }, host)).toThrow(name);
      expect(host.spawned).toHaveLength(0);
    },
  );

  it("starts an omp run with only the OpenRouter key", () => {
    const host = new FakeProcessHost([]);
    ompRun({ PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-x" }, host);
    expect(host.spawned).toHaveLength(1);
  });

  // The CLIs bill a subscription: the OpenRouter key means nothing to them,
  // and their own three keys are refused exactly as before.
  it("keeps the CLIs' rule unchanged", () => {
    expect(forbiddenEnvFor("claude", { OPENROUTER_API_KEY: "sk-or-x" })).toBeNull();
    expect(forbiddenEnvFor("claude", { ANTHROPIC_API_KEY: "x" })).toBe("ANTHROPIC_API_KEY");
    expect(forbiddenEnvFor("codex", { CODEX_API_KEY: "x" })).toBe("CODEX_API_KEY");
    expect(forbiddenEnvFor("codex", { GEMINI_API_KEY: "x" })).toBeNull();
  });
});
