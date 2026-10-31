import { describe, expect, it } from "vitest";
import { approvalFor, ompArgv, thinkingFor } from "./omp.js";

const base = {
  bin: "omp",
  overlayPath: "/creds/u/omp/run/t.yml",
  sessionDir: "/creds/u/omp/sessions/p",
  guardHookPath: "/creds/u/omp/agent/ucch-guard.ts",
  trusted: false,
};

describe("ompArgv", () => {
  it("starts an untrusted turn locked down", () => {
    expect(ompArgv(base)).toEqual([
      "omp",
      "--mode",
      "rpc-ui",
      "--config",
      "/creds/u/omp/run/t.yml",
      "--session-dir",
      "/creds/u/omp/sessions/p",
      "--approval-mode",
      "write",
      "--no-extensions",
      "--no-rules",
      "--no-title",
      "--hook",
      "/creds/u/omp/agent/ucch-guard.ts",
      "--no-lsp",
    ]);
  });

  it("resumes, names the model and effort, and appends the system prompt", () => {
    expect(
      ompArgv({
        ...base,
        trusted: true,
        model: "openrouter/anthropic/claude-sonnet-4.5",
        effort: "high",
        resumeToken: "01a18fd3-9a3c",
        permissionMode: "strict",
        appendSystemPrompt: "Project knowledge.",
        maxTime: "45m",
      }).slice(14),
    ).toEqual([
      "--model",
      "openrouter/anthropic/claude-sonnet-4.5",
      "--thinking",
      "high",
      "--resume",
      "01a18fd3-9a3c",
      "--append-system-prompt",
      "Project knowledge.\n",
      "--max-time",
      "45m",
    ]);
  });

  // OMP would replace a value naming an existing file with the file.
  it("always passes the system prompt as text, never as a path", () => {
    const at = (argv: string[]) => argv[argv.indexOf("--append-system-prompt") + 1];
    expect(at(ompArgv({ ...base, appendSystemPrompt: "/etc/passwd" }))).toBe("/etc/passwd\n");
    expect(at(ompArgv({ ...base, appendSystemPrompt: "already ends\n" }))).toBe("already ends\n");
  });

  it("is fixed for every permission mode × effort × resume × trust", () => {
    const table: Record<string, string> = {};
    for (const permissionMode of ["strict", "normal", "allow_all", undefined] as const) {
      for (const effort of ["off", "low", "medium", "high", "xhigh", "max", undefined] as const) {
        for (const resumeToken of [undefined, "s-1"]) {
          for (const trusted of [false, true]) {
            const key = `${permissionMode ?? "-"} ${effort ?? "-"} ${resumeToken ?? "-"} ${trusted ? "trusted" : "untrusted"}`;
            table[key] = ompArgv({
              ...base,
              trusted,
              ...(permissionMode ? { permissionMode } : {}),
              ...(effort ? { effort } : {}),
              ...(resumeToken ? { resumeToken } : {}),
            })
              .slice(1)
              .join(" ");
          }
        }
      }
    }
    expect(table).toMatchSnapshot();
  });

  it("never lets OMP skip its approvals outside allow_all", () => {
    for (const permissionMode of ["strict", "normal", undefined] as const) {
      const argv = ompArgv({ ...base, trusted: true, ...(permissionMode ? { permissionMode } : {}) });
      expect(argv).not.toContain("--yolo");
      expect(argv).not.toContain("yolo");
    }
    expect(ompArgv({ ...base, permissionMode: "allow_all" })).toContain("yolo");
    expect(ompArgv({ ...base, permissionMode: "allow_all" })).not.toContain("--yolo");
  });

  it("keeps the load-bearing flags under every option", () => {
    for (const trusted of [false, true]) {
      const argv = ompArgv({ ...base, trusted, resumeToken: "s", effort: "max", appendSystemPrompt: "x" });
      for (const flag of ["--no-extensions", "--no-rules", "--hook", "--config"]) expect(argv).toContain(flag);
      expect(argv.slice(1, 3)).toEqual(["--mode", "rpc-ui"]);
      expect(argv.includes("--no-lsp")).toBe(!trusted);
    }
  });
});

describe("mappings", () => {
  it("maps permission modes to approval modes", () => {
    expect(approvalFor("strict")).toBe("always-ask");
    expect(approvalFor("normal")).toBe("write");
    expect(approvalFor(undefined)).toBe("write");
    expect(approvalFor("allow_all")).toBe("yolo");
  });

  it("maps effort to --thinking, and off to no flag", () => {
    expect(thinkingFor(undefined)).toBeNull();
    expect(thinkingFor("off")).toBeNull();
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) expect(thinkingFor(effort)).toBe(effort);
  });
});
