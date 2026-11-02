import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { OMP_FOREIGN_SOURCES, OMP_TOOL_TIERS } from "@ucch/providers";
import { describe, expect, it } from "vitest";
import { guardOverlay, SUBAGENT_READS, writeGuard } from "./guard.js";

const approval = (tools: string[]) => (guardOverlay(tools) as { tools: { approval: Record<string, string> } }).tools.approval;

describe("a call's guard (solution §10.2)", () => {
  it("denies a scout's subagent everything the call did not name but the read-only tools", () => {
    const denied = approval(["read", "grep", "glob", "task"]);
    // What 18.14.1 gave a reviewer and a sonic under `--tools read,grep,glob,task`.
    for (const tool of ["bash", "eval", "web_search", "edit", "write", "lsp", "debug", "browser", "retain", "report_issue"]) {
      expect(denied[tool], tool).toBe("deny");
    }
    for (const tool of ["read", "grep", "glob", "task", ...SUBAGENT_READS]) expect(denied[tool], tool).toBeUndefined();
  });

  it("leaves the tools a call names to it: a sonic's edit and write, a scout's web search", () => {
    const sonic = approval(["read", "grep", "glob", "task", "edit", "write"]);
    expect(sonic.edit).toBeUndefined();
    expect(sonic.write).toBeUndefined();
    expect(sonic.bash).toBe("deny");
    expect(guardOverlay(["read", "web_search"]).web_search).toEqual({ enabled: true });
    expect(guardOverlay(["read"]).web_search).toEqual({ enabled: false });
  });

  it("names every tool of the pinned version, so a lower overlay's allow never survives", () => {
    const denied = approval([]);
    for (const tool of Object.keys(OMP_TOOL_TIERS)) {
      expect(denied[tool] === "deny" || SUBAGENT_READS.has(tool), tool).toBe(true);
    }
    for (const tool of SUBAGENT_READS) expect(OMP_TOOL_TIERS[tool], tool).toBe("read");
  });

  it("turns off tool QA reports, telemetry and the repository's own skills, commands and MCP servers", () => {
    expect(guardOverlay(["read"])).toMatchObject({
      dev: { autoqa: false },
      telemetry: { otlpExportEnabled: false },
      skills: { enableClaudeProject: false, enablePiProject: false, enableAgentsProject: false },
      commands: { enableClaudeProject: false, enableOpencodeProject: false },
      mcp: { enableProjectConfig: false },
    });
  });

  it("reads no other agent's configuration: Claude Code's own MCP servers would be the bridge again", () => {
    expect(guardOverlay(["read"]).disabledProviders).toEqual([...OMP_FOREIGN_SOURCES]);
  });

  it("is written 0600 into a 0700 directory of its own, which dispose removes", async () => {
    const guard = await writeGuard(["read"]);
    expect(statSync(guard.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(guard.path)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(guard.path, "utf8"))).toEqual(guardOverlay(["read"]));
    await guard.dispose();
    expect(existsSync(dirname(guard.path))).toBe(false);
  });
});
