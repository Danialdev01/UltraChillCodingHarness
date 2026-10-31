import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPermissionMode } from "@ucch/protocol";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OMP_SETTINGS,
  OMP_TOOL_TIERS,
  ompApprovals,
  ompContextThreshold,
  ompOverlay,
  overlayKeyPaths,
  toYaml,
  writeOmpOverlay,
  type OmpOverlayInput,
  type OmpPreset,
} from "./omp-overlay.js";

const FIXTURES = join(import.meta.dirname, "../../../packages/providers/src/fixtures");

/** `omp config list --json` of the pinned version (OM0). */
const CONFIG = JSON.parse(readFileSync(join(FIXTURES, "omp-config-list.json"), "utf8")) as Record<string, { type: string }>;
const RECORDS = new Set(Object.entries(CONFIG).filter(([, v]) => v.type === "record").map(([k]) => k));

/** The pinned version's own tool list, from its `--tools` error (OM2.5). */
const BINARY_TOOLS = readFileSync(join(FIXTURES, "omp-tools.txt"), "utf8")
  .replace(/^Built-in tools: |Other registered tools: /g, "")
  .split(/[,.]\s*/)
  .map((name) => name.trim())
  .filter(Boolean);

const base: OmpOverlayInput = {
  settings: DEFAULT_OMP_SETTINGS,
  preset: "standard",
  trusted: false,
  workersPerTurn: 4,
  webSearch: false,
};

/** Every optional block on, so the key-path test sees every key. */
const everything: OmpOverlayInput = {
  ...base,
  settings: {
    models: { default: "anthropic/claude-sonnet-4.5", fast: "openai/gpt-5-mini", deep: "openrouter/anthropic/claude-opus-4.1" },
    memory: { enabled: true, llmMode: "none" },
    economy: true,
    advisor: true,
    browser: true,
  },
  trusted: true,
  webSearch: true,
  memoryDbPath: "/creds/u/omp/memories/p/mnemopi.db",
  hostTools: ["research_search", "doc_render"],
};

const MODES: (AgentPermissionMode | undefined)[] = [undefined, "strict", "normal", "allow_all"];
const PRESETS: OmpPreset[] = ["standard", "research", "documentation"];

describe("ompOverlay", () => {
  it.each(PRESETS.flatMap((preset) => MODES.map((mode) => [preset, mode ?? "default"] as const)))(
    "writes the %s preset under %s",
    (preset, mode) => {
      const input = { ...base, preset, ...(mode === "default" ? {} : { permissionMode: mode as AgentPermissionMode }) };
      expect(toYaml(ompOverlay(input))).toMatchSnapshot();
    },
  );

  it("sets only keys the pinned version has", () => {
    for (const input of [base, everything]) {
      const missing = overlayKeyPaths(ompOverlay(input), RECORDS).filter((path) => !(path in CONFIG));
      expect(missing).toEqual([]);
    }
  });

  it("allows the host tools under every mode, since runTool's gate asks for them", () => {
    for (const permissionMode of ["strict", "normal", "allow_all"] as const) {
      const approvals = ompApprovals({ ...everything, permissionMode });
      expect([approvals.research_search, approvals.doc_render]).toEqual(["allow", "allow"]);
    }
  });

  it("names every tool the pinned binary registers, and every host tool", () => {
    expect(BINARY_TOOLS).toContain("bash");
    expect(BINARY_TOOLS).toContain("update_notes");
    const named = Object.keys(ompApprovals(everything));
    for (const tool of [...BINARY_TOOLS, "research_search", "doc_render", "report_issue", "ast_edit", "lsp", "debug"]) {
      expect(named).toContain(tool);
    }
  });

  it("follows OMP's own tier table for each mode", () => {
    const at = (mode: AgentPermissionMode | undefined) => ompApprovals({ ...base, trusted: true, webSearch: true, permissionMode: mode });
    expect(at("strict")).toMatchObject({ read: "allow", grep: "allow", write: "prompt", edit: "prompt", bash: "prompt", task: "prompt" });
    expect(at("normal")).toMatchObject({ read: "allow", write: "allow", edit: "allow", bash: "prompt", eval: "prompt", debug: "prompt" });
    expect(at(undefined)).toEqual(at("normal"));
    expect(at("allow_all")).toMatchObject({ read: "allow", write: "allow", bash: "allow", task: "allow", debug: "allow" });
  });

  it("denies what UCCH does not offer under every mode, allow_all included", () => {
    for (const mode of MODES) {
      const approvals = ompApprovals({ ...everything, permissionMode: mode });
      for (const tool of ["ask", "github", "computer", "generate_image", "tts", "hub", "report_issue"]) {
        expect(approvals[tool]).toBe("deny");
      }
    }
  });

  it("never lets a tool run unasked under strict unless it is read tier", () => {
    const approvals = ompApprovals({ ...everything, permissionMode: "strict" });
    for (const [tool, policy] of Object.entries(approvals)) {
      if (policy === "allow") expect([tool, OMP_TOOL_TIERS[tool] ?? "read"]).toEqual([tool, "read"]);
    }
  });

  it("keeps research from changing the worktree, and leaves documentation's writes to the guard hook", () => {
    expect(ompApprovals({ ...base, preset: "research", permissionMode: "allow_all" })).toMatchObject({
      write: "deny",
      edit: "deny",
      ast_edit: "deny",
      read: "allow",
    });
    expect(ompApprovals({ ...base, preset: "documentation" })).toMatchObject({ write: "allow", edit: "allow" });
  });

  it("turns debugging off for an untrusted project, where its dap.json would load", () => {
    expect(ompOverlay(base)).toMatchObject({ debug: { enabled: false } });
    expect(ompApprovals(base).debug).toBe("deny");
    expect(ompOverlay({ ...base, trusted: true })).toMatchObject({ debug: { enabled: true } });
  });

  it("gates the browser and web search on the workspace", () => {
    expect(ompOverlay(base)).toMatchObject({ browser: { enabled: false }, web_search: { enabled: false } });
    expect(ompApprovals(base)).toMatchObject({ browser: "deny", web_search: "deny" });
    expect(ompOverlay(everything)).toMatchObject({ browser: { enabled: true }, web_search: { enabled: true } });
    expect(ompApprovals(everything)).toMatchObject({ browser: "prompt", web_search: "allow" });
  });

  it("names every model role, on OpenRouter, so a project can bill none", () => {
    expect(ompOverlay(everything).modelRoles).toEqual({
      default: "openrouter/anthropic/claude-sonnet-4.5",
      smol: "openrouter/openai/gpt-5-mini",
      slow: "openrouter/anthropic/claude-opus-4.1",
      plan: "openrouter/anthropic/claude-opus-4.1",
      vision: "openrouter/anthropic/claude-sonnet-4.5",
      commit: "openrouter/openai/gpt-5-mini",
      advisor: "openrouter/anthropic/claude-opus-4.1",
    });
    expect(ompOverlay({ ...base, settings: { ...DEFAULT_OMP_SETTINGS, models: { default: "x/y" } } }).modelRoles).toEqual({
      default: "openrouter/x/y",
      smol: "openrouter/x/y",
      slow: "openrouter/x/y",
      plan: "openrouter/x/y",
      vision: "openrouter/x/y",
      commit: "openrouter/x/y",
      advisor: "openrouter/x/y",
    });
  });

  it("switches off everything that bills, spawns or reports without being asked", () => {
    expect(ompOverlay(base)).toMatchObject({
      memory: { backend: "off" },
      contextPromotion: { enabled: false },
      retry: { modelFallback: false },
      autolearn: { enabled: false },
      advisor: { enabled: false },
      prewalk: { enabled: false },
      recap: { enabled: false },
      speech: { enabled: false },
      dev: { autoqa: false },
      telemetry: { otlpExportEnabled: false },
      mcp: { enableProjectConfig: false },
      skills: { enableClaudeProject: false, enablePiProject: false, enableAgentsProject: false },
      commands: { enableClaudeProject: false, enableOpencodeProject: false },
    });
  });

  it("turns memory on only with a database path", () => {
    expect(() => ompOverlay({ ...base, settings: { ...DEFAULT_OMP_SETTINGS, memory: { enabled: true, llmMode: "smol" } } })).toThrow(/database/);
    expect(ompOverlay(everything)).toMatchObject({
      memory: { backend: "mnemopi" },
      mnemopi: { scoping: "global", dbPath: "/creds/u/omp/memories/p/mnemopi.db", llmMode: "none" },
    });
  });

  it("sizes the worker pool from the server's cap", () => {
    expect(ompOverlay({ ...base, workersPerTurn: 2 })).toMatchObject({ task: { maxConcurrency: 2, maxRecursionDepth: 1 } });
  });
});

describe("ompContextThreshold", () => {
  it("reads OMP's two settings, taking 0 or below as unset", () => {
    expect(ompContextThreshold({ compaction: { thresholdTokens: 90000, thresholdPercent: 80 } })).toEqual({ tokens: 90000, percent: 80 });
    expect(ompContextThreshold({ compaction: { thresholdTokens: -1, thresholdPercent: 0 } })).toEqual({});
    expect(ompContextThreshold({ compaction: { thresholdPercent: "80" } })).toEqual({});
    expect(ompContextThreshold({})).toEqual({});
  });
});

describe("toYaml", () => {
  it("quotes every string, so a value cannot become YAML", () => {
    expect(toYaml({ a: { b: "x: #y\n- z", c: ["p", "q"], d: true, e: 3 } })).toBe(
      'a:\n  b: "x: #y\\n- z"\n  c: ["p", "q"]\n  d: true\n  e: 3\n',
    );
  });

  it("refuses what it cannot write", () => {
    expect(() => toYaml({ a: Number.NaN })).toThrow();
    expect(() => toYaml({ a: () => 1 })).toThrow();
  });
});

describe("writeOmpOverlay", () => {
  it("writes the turn's file 0600 and deletes it on dispose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-overlay-"));
    const { path, dispose } = await writeOmpOverlay(dir, "00000000-0000-4000-8000-000000000003", base);
    expect(path).toBe(join(dir, "00000000-0000-4000-8000-000000000003.yml"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("tools:\n  approval:\n");
    await dispose();
    expect(existsSync(path)).toBe(false);
    await dispose();
  });

  it("returns where its compaction starts, for the context meter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-overlay-"));
    const written = await writeOmpOverlay(dir, "00000000-0000-4000-8000-000000000004", base);
    // UCCH leaves OMP's own threshold in place, so the meter knows none.
    expect(written.contextThreshold).toEqual({});
    await written.dispose();
  });

  it("refuses a turn id that is not one", async () => {
    await expect(writeOmpOverlay(tmpdir(), "../x", base)).rejects.toThrow(/turn id/);
  });
});
