import { describe, expect, it } from "vitest";
import ucchGuard, { decide, editPaths, type GuardContext, type ToolCallEvent } from "../assets/omp-hooks/ucch-guard.js";

const ctx: GuardContext = { worktree: "/wt/thread", preset: undefined, pid: 100, parentOf: () => null };
const bash = (command: string, cwd?: string): ToolCallEvent => ({ toolName: "bash", input: { command, ...(cwd ? { cwd } : {}) } });
const blocked = (event: ToolCallEvent, c: GuardContext = ctx) => decide(event, c)?.block === true;

describe("the OMP guard hook", () => {
  // Registered as OMP registers it: `pi.on("tool_call", …)` and an event.
  it("blocks git push in a tool_call event, through the hook OMP loads", () => {
    let handler: ((event: ToolCallEvent) => unknown) | undefined;
    ucchGuard({ on: (_name, h) => (handler = h) });
    expect(handler?.(bash("git push origin main"))).toEqual({ block: true, reason: expect.stringMatching(/git push/) });
    expect(handler?.(bash("git status"))).toBeUndefined();
  });

  it("blocks pushes and commits however git is invoked", () => {
    for (const command of [
      "git push",
      "git push --force origin HEAD",
      "git -C . push",
      "npm test && git push -f",
      "git commit -m wip",
      "git --no-pager commit --amend",
      "(cd sub; git commit -am x)",
    ]) {
      expect(blocked(bash(command)), command).toBe(true);
    }
    for (const command of ["git status", "git log --grep push", "cat git-push-notes.md", "git diff HEAD~1"]) {
      expect(blocked(bash(command)), command).toBe(false);
    }
  });

  it("blocks git reset --hard aimed outside the worktree, not inside it", () => {
    expect(blocked(bash("git -C /srv/other reset --hard"))).toBe(true);
    expect(blocked(bash("cd /etc && git reset --hard"))).toBe(true);
    expect(blocked(bash("git reset --hard HEAD~1"))).toBe(false);
    expect(blocked(bash("git reset --soft HEAD~1"))).toBe(false);
  });

  it("blocks reading the environment, but not scripts that set it", () => {
    for (const command of ["printenv", "printenv OPENROUTER_API_KEY", "env", "env | grep KEY", "cat /proc/self/environ", "set", "export -p"]) {
      expect(blocked(bash(command)), command).toBe(true);
    }
    for (const command of ["env NODE_ENV=test npm test", "set -euo pipefail; make", "echo environment"]) {
      expect(blocked(bash(command)), command).toBe(false);
    }
  });

  it("keeps shells, writes and edits inside the worktree", () => {
    expect(blocked(bash("ls", "/etc"))).toBe(true);
    expect(blocked(bash("ls", "src"))).toBe(false);
    expect(blocked({ toolName: "write", input: { path: "../other/x.ts", content: "" } })).toBe(true);
    expect(blocked({ toolName: "write", input: { path: "/etc/passwd", content: "" } })).toBe(true);
    expect(blocked({ toolName: "write", input: { path: "src/x.ts", content: "" } })).toBe(false);
    expect(blocked({ toolName: "write", input: { path: "/wt/thread/src/x.ts", content: "" } })).toBe(false);
    expect(blocked({ toolName: "edit", input: { input: "[src/a.ts#A1B2]\nPUT 1.=1:\n+x\n" } })).toBe(false);
    expect(blocked({ toolName: "edit", input: { input: "[src/a.ts#A1B2]\nMV ../../elsewhere.ts\n" } })).toBe(true);
    expect(blocked({ toolName: "edit", input: { input: "[/root/.bashrc#00ff]\nPUT >$:\n+x\n" } })).toBe(true);
    // An edit that names no file cannot be checked, so it is refused.
    expect(blocked({ toolName: "edit", input: { input: "PUT 1.=1:\n+x\n" } })).toBe(true);
  });

  it("reads the files an edit patch names", () => {
    expect(editPaths('[a.ts#A1B2]\nPUT 1.=1:\n+x\n[docs/b c.md#3C4D]\nMV "docs/d e.md"\n')).toEqual([
      "a.ts",
      "docs/b c.md",
      "docs/d e.md",
    ]);
  });

  it("confines writes to docs/ in the documentation preset", () => {
    const docs = { ...ctx, preset: "documentation" };
    expect(blocked({ toolName: "write", input: { path: "docs/guide.md", content: "" } }, docs)).toBe(false);
    expect(blocked({ toolName: "write", input: { path: "src/x.ts", content: "" } }, docs)).toBe(true);
    expect(blocked({ toolName: "write", input: { path: "docs/../src/x.ts", content: "" } }, docs)).toBe(true);
  });

  it("lets host tools through, and attaches the debugger only to the turn's own processes", () => {
    const tree: GuardContext = { ...ctx, parentOf: (pid) => ({ 300: 200, 200: 100, 400: 1 })[pid] ?? null };
    const attach = (pid: unknown): ToolCallEvent => ({
      toolName: "write",
      input: { path: "xd://debug", content: JSON.stringify({ action: "attach", pid }) },
    });
    expect(blocked({ toolName: "write", input: { path: "xd://ucch_echo", content: "{}" } })).toBe(false);
    expect(blocked(attach(300), tree)).toBe(false);
    expect(blocked(attach(400), tree)).toBe(true);
    expect(blocked(attach("1"), tree)).toBe(true);
    expect(blocked({ toolName: "write", input: { path: "xd://debug", content: '{"action":"launch","program":"a.js"}' } }, tree)).toBe(false);
    expect(blocked({ toolName: "write", input: { path: "xd://debug", content: "not json" } }, tree)).toBe(true);
  });

  it("allows only OMP's bundled subagents", () => {
    const task = (agent?: string): ToolCallEvent => ({ toolName: "task", input: { tasks: [{ task: "x", ...(agent ? { agent } : {}) }] } });
    expect(blocked(task("scout"))).toBe(false);
    expect(blocked(task())).toBe(false);
    expect(blocked(task("plantagent"))).toBe(true);
  });
});
