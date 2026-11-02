import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HostProcessHost, type ProcessHost } from "@ucch/providers";
import { ManualChild } from "@ucch/providers/testing";
import { describe, expect, it } from "vitest";
import { callArgv, cap, costLine, RESULT_BYTES, runOmpCall, type CallContext } from "./call.js";
import { readBridgeConfig } from "./config.js";
import { watched } from "./test-host.js";

/** fake-omp replays a recorded RPC turn, with no key and no network (scripts/load/fake-omp.mjs). */
const FAKE_OMP = join(import.meta.dirname, "../../../scripts/load/fake-omp.mjs");
const FIXTURES = join(import.meta.dirname, "../../providers/src/fixtures");

function ctx(host: ProcessHost, fixture = "omp-plain.jsonl", env: NodeJS.ProcessEnv = {}): CallContext {
  return {
    config: readBridgeConfig({ UCCH_OMP_BIN: FAKE_OMP, UCCH_BRIDGE_MAX_SECONDS: "60", ...env }, import.meta.dirname),
    host,
    parentEnv: { PATH: process.env.PATH, FAKE_OMP_FIXTURE: join(FIXTURES, fixture) },
  };
}

describe("callArgv", () => {
  const config = readBridgeConfig({ UCCH_OMP_BIN: "/opt/omp/bin/omp", UCCH_BRIDGE_MAX_SECONDS: "120", UCCH_OMP_OVERLAY: "/c/omp/run/b.yml" }, "/w");

  it("runs one throwaway RPC session on the allowlist, unattended, with a turn's guards and the call's guard last", () => {
    expect(callArgv(config, { tools: ["read", "grep"], model: "@smol" }, "/tmp/g/guard.yml")).toEqual([
      "/opt/omp/bin/omp",
      "--mode",
      "rpc",
      "--no-session",
      "--no-title",
      "--model",
      "@smol",
      "--max-time",
      "120",
      "--approval-mode",
      "yolo",
      "--tools",
      "read,grep",
      "--no-extensions",
      "--no-rules",
      "--no-lsp",
      "--config",
      "/c/omp/run/b.yml",
      "--config",
      "/tmp/g/guard.yml",
    ]);
  });

  it("starts a language server only for a trusted project's call that asks for lsp, and no tools at all for an empty list", () => {
    expect(callArgv(config, { tools: ["lsp", "read"], model: "@smol" }, "/tmp/g/guard.yml")).toContain("--no-lsp");
    expect(callArgv({ ...config, trusted: true }, { tools: ["lsp", "read"], model: "@smol" }, "/tmp/g/guard.yml")).not.toContain("--no-lsp");
    expect(callArgv({ ...config, trusted: true }, { tools: ["read"], model: "@smol" }, "/tmp/g/guard.yml")).toContain("--no-lsp");
    const none = callArgv(config, { tools: [], model: "@smol" }, "/tmp/g/guard.yml");
    expect(none).toContain("--no-tools");
    expect(none).not.toContain("--tools");
  });

  it("never runs RPC with prompts: yolo, under an allowlist", () => {
    const argv = callArgv(config, { tools: ["read"], model: "@smol" }, "/tmp/g/guard.yml");
    expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("yolo");
    expect(argv).not.toContain("rpc-ui");
  });
});

describe("the result format", () => {
  it("ends with one cost line", () => {
    expect(costLine(3100, 800, 0.0041, 21_400)).toBe("omp: 3.1k in / 800 out · $0.0041 · 21 s");
    expect(costLine(0, 0, 0, 0)).toBe("omp: 0 in / 0 out · $0 · 0 s");
  });

  it("holds the text to 64 KB of UTF-8, cut on a character", () => {
    expect(cap("short")).toBe("short");
    const capped = cap("é".repeat(RESULT_BYTES));
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(RESULT_BYTES);
    expect(capped).toMatch(/é\n\[… truncated\]$/);
    expect(capped).not.toContain("�");
  });
});

describe("runOmpCall", () => {
  it("answers with the final assistant text and the cost line", async () => {
    const { host } = watched();
    let clock = 0;
    const result = await runOmpCall({ ...ctx(host), now: () => (clock += 10_500) }, { tools: ["read"], model: "@smol", prompt: "Say hello.", answer: {} });
    // fake-omp's stats: 1200 in, 80 out, $0.0012 per turn.
    expect(result).toEqual({ content: [{ type: "text", text: "Hello from the scripted model.\n\nomp: 1.2k in / 80 out · $0.0012 · 11 s" }] });
  });

  it("answers with the subagents' results when asked to", async () => {
    const { host } = watched();
    const result = await runOmpCall(ctx(host, "omp-subagent.jsonl"), { tools: ["task"], model: "@smol", prompt: "Scout.", answer: { subagents: true } });
    expect(result.isError).toBeUndefined();
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^src\/a\.ts exports `a`\.\n\nomp: /);
  });

  it("fails with OMP's one-line reason when the turn fails, and never throws", async () => {
    const { host } = watched();
    const result = await runOmpCall(ctx(host, "omp-error.jsonl"), { tools: [], model: "@smol", prompt: "Hello?", answer: {} });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^omp failed: 400 /);
    expect((result.content as { text: string }[])[0]!.text).not.toContain("\n");
  });

  it("bills the workspace's key only: a key in the CLI's environment never reaches omp", async () => {
    const { host, spawned } = watched();
    const base = ctx(host, "omp-plain.jsonl", { OPENROUTER_API_KEY: "sk-or-ws" });
    const parentEnv = { ...base.parentEnv, ANTHROPIC_API_KEY: "sk-ant-operator", OPENAI_API_KEY: "sk-operator", OPENROUTER_API_KEY: "sk-or-other" };
    const result = await runOmpCall({ ...base, parentEnv }, { tools: [], model: "@smol", prompt: "x", answer: {} });
    expect(result.isError).toBeUndefined();
    const env = spawned[0]!.spec.env;
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-ws");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("passes each call its guard as the last --config, and removes it once the call is over", async () => {
    const { host, spawned } = watched();
    let guard = "";
    let seen: { tools: { approval: Record<string, string> }; dev: { autoqa: boolean } } | null = null;
    const reading: ProcessHost = {
      spawn(spec) {
        guard = spec.argv[spec.argv.length - 1]!;
        seen = JSON.parse(readFileSync(guard, "utf8"));
        return host.spawn(spec);
      },
      run: (spec, options) => host.run(spec, options),
    };
    const result = await runOmpCall(ctx(reading), { tools: ["read", "task"], model: "@smol", prompt: "x", answer: {} });
    expect(result.isError).toBeUndefined();
    const argv = spawned[0]!.spec.argv;
    expect(argv.slice(-2)).toEqual(["--config", guard]);
    expect(seen!.tools.approval.bash).toBe("deny");
    expect(seen!.tools.approval.task).toBeUndefined();
    expect(seen!.dev.autoqa).toBe(false);
    expect(existsSync(guard)).toBe(false);
  });

  it("reports an omp that will not start as a tool error", async () => {
    const result = await runOmpCall(
      { ...ctx(new HostProcessHost()), config: { ...ctx(new HostProcessHost()).config, ompBin: "/nonexistent/omp" } },
      { tools: [], model: "@smol", prompt: "x", answer: {} },
    );
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toMatch(/^omp did not start: /);
  });

  it("kills a call that stops answering, past --max-time, and says so", async () => {
    let child!: ManualChild;
    const host: ProcessHost = {
      spawn(spec) {
        child = new ManualChild(spec);
        // Ready, and the protocol answered; then silence.
        child.onWrite = (line) => {
          const frame = JSON.parse(line) as { id?: string; type?: string };
          if (frame.type === "negotiate_protocol") {
            child.emit(JSON.stringify({ id: frame.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } }));
          }
        };
        child.onSignal = () => child.exit({ code: null, signal: "SIGTERM" });
        queueMicrotask(() => child.emit(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2] })));
        return child.handle;
      },
      run: () => Promise.reject(new Error("not used")),
    };
    const base = ctx(host);
    const result = await runOmpCall(
      { ...base, config: { ...base.config, maxSeconds: 1 }, graceMs: 0 },
      { tools: [], model: "@smol", prompt: "x", answer: {} },
    );
    expect(result).toEqual({ content: [{ type: "text", text: "omp did not finish within 1 s" }], isError: true });
    expect(child.signals).toContain("SIGTERM");
  });

  it("with stopAfter, aborts once that tool has answered and answers with its result", async () => {
    const { host, spawned } = watched();
    const result = await runOmpCall(ctx(host, "omp-bridge-codemod.jsonl"), {
      tools: ["ast_edit", "read"],
      model: "@smol",
      prompt: "Preview.",
      answer: { toolResults: ["ast_edit"] },
      stopAfter: "ast_edit",
    });
    expect(result.isError).toBeUndefined();
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toMatch(/^ast_edit:\nStaged as a proposal/);
    expect(text).toContain("+2:18 newName(2)");
    expect(spawned[0]!.written.map((frame) => frame.type)).toContain("abort");
  });

  it("without stopAfter, an aborted turn is a failure, not an answer", async () => {
    const { host } = watched();
    const result = await runOmpCall(ctx(host, "omp-bridge-codemod.jsonl"), {
      tools: ["ast_edit", "read"],
      model: "@smol",
      prompt: "Preview.",
      answer: { toolResults: ["ast_edit"] },
    });
    expect(result).toEqual({ content: [{ type: "text", text: "omp stopped before it answered" }], isError: true });
  });
});
