import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@ucch/db";
import { codexMcpArgs } from "@ucch/providers";
import { encryptSecret } from "./crypto.js";
import { TerminalBridge, terminalBridgeFacts, type TerminalBridgeFacts } from "./terminal-bridge.js";

const SECRET = "cd".repeat(32);
const TERMINAL = "77777777-7777-7777-7777-777777777777";

describe("TerminalBridge", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-term-bridge-"));
    await mkdir(join(root, "run"), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function bridge(facts: TerminalBridgeFacts | null, withSecret = true) {
    const tokens = new Set<string>();
    const terminal = new TerminalBridge({
      bin: "/opt/ucch/omp-bridge.mjs",
      ompBin: "/usr/bin/omp",
      socket: "/creds/omp-scheduler.sock",
      maxSeconds: 300,
      leases: {
        register: () => {
          tokens.add("tok");
          return { token: "tok", revoke: () => void tokens.delete("tok") };
        },
      },
      secretKey: withSecret ? SECRET : undefined,
      defaultModel: "anthropic/claude-sonnet-4.5",
      runDir: () => join(root, "run"),
      agentDir: () => "/creds/u/omp/agent",
      facts: async () => facts,
    });
    return { terminal, tokens };
  }
  const open = (terminal: TerminalBridge) =>
    terminal.open({ projectId: "p", subject: "u", userId: "u", terminalId: TERMINAL, cwd: "/ws/p" });
  const on = { enabled: true, openrouterKeyEncrypted: encryptSecret("sk-or-term", SECRET), defaultModel: null };

  it("writes the Claude config, the Codex arguments and one 0600 file with the key; and takes all of it down", async () => {
    const { terminal, tokens } = bridge(on);
    const path = terminal.path("u", TERMINAL);
    expect(path).toBe(join(root, "run", `term-${TERMINAL}.mcp.json`));
    const handle = await open(terminal);
    const envFile = join(root, "run", `term-${TERMINAL}.bridge.json`);
    const visible = { UCCH_BRIDGE_ENV_FILE: envFile };
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      mcpServers: { omp: { command: process.execPath, args: ["/opt/ucch/omp-bridge.mjs"], env: visible } },
    });
    // Asked by the CLI itself: no pre-approval, a timeout past the bridge's own.
    expect(readFileSync(join(root, "run", `term-${TERMINAL}.codex`), "utf8")).toBe(
      `${codexMcpArgs("omp", { command: process.execPath, args: ["/opt/ucch/omp-bridge.mjs"], env: visible, toolTimeoutSec: 370 }).join("\n")}\n`,
    );
    const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
    expect(env).toMatchObject({ OPENROUTER_API_KEY: "sk-or-term", UCCH_BRIDGE_TOKEN: "tok", UCCH_WORKTREE: "/ws/p", UCCH_BRIDGE_MAX_SECONDS: "300" });
    expect(env.UCCH_OMP_TRUSTED).toBeUndefined();
    const files = readdirSync(join(root, "run")).sort();
    expect(files).toEqual([`bridge-term-${TERMINAL}.yml`, `term-${TERMINAL}.bridge.json`, `term-${TERMINAL}.codex`, `term-${TERMINAL}.mcp.json`]);
    for (const file of files) expect(statSync(join(root, "run", file)).mode & 0o777, file).toBe(0o600);
    // The key is in the one file only.
    for (const file of files.filter((f) => !f.endsWith(".bridge.json"))) expect(readFileSync(join(root, "run", file), "utf8")).not.toContain("sk-or-term");
    expect(readFileSync(join(root, "run", `bridge-term-${TERMINAL}.yml`), "utf8")).toContain('  default: "openrouter/anthropic/claude-sonnet-4.5"\n');
    expect(tokens.size).toBe(1);

    await handle!.dispose();
    expect(readdirSync(join(root, "run"))).toEqual([]);
    expect(tokens.size).toBe(0);
  });

  it("writes nothing with the setting off, without a key, without SECRET_KEY, or for a project it cannot find", async () => {
    for (const { terminal } of [
      bridge({ ...on, enabled: false }),
      bridge({ ...on, openrouterKeyEncrypted: null }),
      bridge(on, false),
      bridge(null),
    ]) {
      expect(await open(terminal)).toBeNull();
    }
    expect(readdirSync(join(root, "run"))).toEqual([]);
    expect(existsSync(join(root, "run", `term-${TERMINAL}.mcp.json`))).toBe(false);
  });

  it("refuses a terminal id that is not one", () => {
    expect(() => bridge(on).terminal.path("u", "../x")).toThrow();
  });
});

describe("terminalBridgeFacts", () => {
  /** A database answering its selects in order. */
  function db(...rows: unknown[][]) {
    const next = () => Promise.resolve(rows.shift() ?? []);
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "innerJoin", "where"]) chain[step] = () => chain;
    chain.limit = next;
    return { select: () => chain } as unknown as Database;
  }
  const project = { agent: { ompBridge: { enabled: true } }, workspaceId: "w1", workspaceKey: "ws-key" };
  const person = { key: "person-key", defaultModel: "openai/gpt-5" };

  it("bills a member's terminal to the person, and a workspace subject's to the workspace", async () => {
    expect(await terminalBridgeFacts(db([project], [person]))("p", "u", "u")).toEqual({
      enabled: true,
      openrouterKeyEncrypted: "person-key",
      defaultModel: "openai/gpt-5",
    });
    expect(await terminalBridgeFacts(db([project], [person]))("p", "ws-w1", "u")).toMatchObject({ openrouterKeyEncrypted: "ws-key" });
  });

  it("is off by default, and nothing for another workspace's subject or a missing row", async () => {
    expect(await terminalBridgeFacts(db([{ ...project, agent: {} }], [person]))("p", "u", "u")).toMatchObject({ enabled: false });
    expect(await terminalBridgeFacts(db([project], [person]))("p", "ws-other", "u")).toBeNull();
    expect(await terminalBridgeFacts(db([], [person]))("p", "u", "u")).toBeNull();
    expect(await terminalBridgeFacts(db([project], []))("p", "u", "u")).toBeNull();
  });
});
