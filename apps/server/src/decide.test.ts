import { describe, expect, it } from "vitest";
import type { Command } from "@ucch/protocol";
import {
  decide,
  normalizeWorkspacePath,
  type DecisionContext,
  type DecisionState,
  type ProjectSnapshot,
  type ThreadSnapshot,
  type TurnSnapshot,
  type WorkspaceSnapshot,
} from "./decide.js";

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "55555555-5555-5555-5555-555555555555";
const WORKSPACE = "77777777-7777-7777-7777-777777777777";
const NEW_ID = "66666666-6666-6666-6666-666666666666";

const ctx: DecisionContext = {
  userId: USER,
  now: new Date("2026-09-02T00:00:00Z"),
  newId: () => NEW_ID,
  newHash: () => "abcdef123456",
};

const workspace = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  id: WORKSPACE,
  ownerUserId: USER,
  ...over,
});

const project = (over: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  id: PROJECT,
  hash: "abcdef123456",
  workspaceId: WORKSPACE,
  userId: USER,
  containerState: "running",
  defaultBranch: "main",
  ...over,
});

const thread = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({
  id: THREAD,
  projectId: PROJECT,
  status: "idle",
  ...over,
});

const turn = (over: Partial<TurnSnapshot> = {}): TurnSnapshot => ({
  id: TURN,
  threadId: THREAD,
  seq: 0,
  checkpointBefore: "deadbeef",
  revertedAt: null,
  ...over,
});

function run(state: DecisionState, command: Command) {
  return decide(state, command, ctx);
}

describe("project.create", () => {
  it("derives a name from the repository URL", () => {
    const d = run({ workspace: workspace() }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      repoUrl: "https://github.com/laravel/laravel.git",
    });
    expect(d).toMatchObject({
      ok: true,
      events: [
        { type: "project.created", name: "laravel", defaultBranch: "main", workspaceId: WORKSPACE },
      ],
    });
  });

  it("prefers an explicit name and branch", () => {
    const d = run({ workspace: workspace() }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      repoUrl: "https://github.com/a/b",
      name: "  My App  ",
      branch: "develop",
    });
    expect(d).toMatchObject({
      ok: true,
      events: [{ name: "My App", defaultBranch: "develop" }],
    });
  });

  // The workspace boundary has to be enforced, not advisory: without these
  // two checks a caller could drop a project into somebody else's workspace.
  it("refuses a workspace owned by someone else", () => {
    const d = run({ workspace: workspace({ ownerUserId: OTHER_USER }) }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      repoUrl: "https://github.com/a/b",
    });
    expect(d).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses a workspace that does not exist", () => {
    const d = run({}, {
      type: "project.create",
      workspaceId: WORKSPACE,
      repoUrl: "https://github.com/a/b",
    });
    expect(d).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("project lifecycle", () => {
  it("starts a stopped project", () => {
    const d = run({ project: project({ containerState: "stopped" }) }, {
      type: "project.start",
      projectId: PROJECT,
    });
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: "container.state_changed", state: "creating" }],
    });
  });

  // Re-emitting `creating` would make the reactor start a second container
  // for the same project.
  it.each(["running", "creating"] as const)("is a no-op when already %s", (containerState) => {
    const d = run({ project: project({ containerState }) }, {
      type: "project.start",
      projectId: PROJECT,
    });
    expect(d).toEqual({ ok: true, events: [] });
  });

  it("is a no-op when stopping an already-stopped project", () => {
    const d = run({ project: project({ containerState: "stopped" }) }, {
      type: "project.stop",
      projectId: PROJECT,
    });
    expect(d).toEqual({ ok: true, events: [] });
  });
});

describe("authorization", () => {
  it("hides another user's project behind not_found", () => {
    const d = run({ project: project({ userId: OTHER_USER }) }, {
      type: "project.start",
      projectId: PROJECT,
    });
    // Not `forbidden`: whether the project exists is itself privileged.
    expect(d).toEqual({ ok: false, error: { code: "not_found", message: "project not found" } });
  });

  it("reports a missing project identically", () => {
    const d = run({}, { type: "project.start", projectId: PROJECT });
    expect(d).toEqual({ ok: false, error: { code: "not_found", message: "project not found" } });
  });
});

describe("thread.send", () => {
  it("records the user message", () => {
    const d = run({ project: project(), thread: thread() }, {
      type: "thread.send",
      threadId: THREAD,
      text: "add a health route",
    });
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: "user.message", text: "add a health route" }],
    });
  });

  // Two concurrent turns would interleave edits to one working tree.
  it.each(["running", "cancelling"] as const)("refuses while a turn is %s", (status) => {
    const d = run({ project: project(), thread: thread({ status }) }, {
      type: "thread.send",
      threadId: THREAD,
      text: "hi",
    });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("thread.revert", () => {
  it("reverts to the checkpoint taken before the turn", () => {
    const d = run({ project: project(), thread: thread(), turn: turn() }, {
      type: "thread.revert",
      threadId: THREAD,
      turnId: TURN,
    });
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: "checkpoint.reverted", commitSha: "deadbeef" }],
    });
  });

  it("refuses a turn with no checkpoint", () => {
    const d = run({ project: project(), thread: thread(), turn: turn({ checkpointBefore: null }) }, {
      type: "thread.revert",
      threadId: THREAD,
      turnId: TURN,
    });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses to revert twice", () => {
    const d = run({ project: project(), thread: thread(), turn: turn({ revertedAt: new Date() }) }, {
      type: "thread.revert",
      threadId: THREAD,
      turnId: TURN,
    });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses while a turn is running", () => {
    const d = run({ project: project(), thread: thread({ status: "running" }), turn: turn() }, {
      type: "thread.revert",
      threadId: THREAD,
      turnId: TURN,
    });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("refuses a turn belonging to another thread", () => {
    const d = run({ project: project(), thread: thread(), turn: turn({ threadId: "other" }) }, {
      type: "thread.revert",
      threadId: THREAD,
      turnId: TURN,
    });
    expect(d).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("container-dependent commands", () => {
  const cases: Command[] = [
    { type: "file.write", projectId: PROJECT, path: "a.txt", content: "x" },
    { type: "git.commit", projectId: PROJECT, message: "m" },
    { type: "git.push", projectId: PROJECT, branch: "main" },
  ];

  it.each(cases)("refuses $type when the container is not running", (command) => {
    const d = run({ project: project({ containerState: "stopped" }) }, command);
    expect(d).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("terminal commands", () => {
  it("are accepted without producing durable events", () => {
    const d = run({ project: project() }, { type: "terminal.input", terminalId: "t1", data: "ls\n" });
    expect(d).toMatchObject({ ok: true, events: [], passthrough: true });
  });
});

describe("normalizeWorkspacePath", () => {
  it("normalizes ordinary paths", () => {
    expect(normalizeWorkspacePath("app/Http/Controllers/X.php")).toBe("app/Http/Controllers/X.php");
    expect(normalizeWorkspacePath("/routes/web.php")).toBe("routes/web.php");
    expect(normalizeWorkspacePath("./a//b/./c")).toBe("a/b/c");
    expect(normalizeWorkspacePath("a/b/../c")).toBe("a/c");
  });

  // The boundary that stops a client or an agent tool writing outside the mount.
  it("rejects traversal outside the workspace", () => {
    expect(normalizeWorkspacePath("../etc/passwd")).toBeNull();
    expect(normalizeWorkspacePath("a/../../etc/passwd")).toBeNull();
    expect(normalizeWorkspacePath("/../x")).toBeNull();
  });

  it("rejects empty paths and null bytes", () => {
    expect(normalizeWorkspacePath("")).toBeNull();
    expect(normalizeWorkspacePath("/")).toBeNull();
    expect(normalizeWorkspacePath("a\0b")).toBeNull();
  });

  it("rejects a traversing path in file.write", () => {
    const d = run({ project: project() }, {
      type: "file.write",
      projectId: PROJECT,
      path: "../../etc/passwd",
      content: "x",
    });
    expect(d).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});
