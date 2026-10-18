import { describe, expect, it } from "vitest";
import type { Command, Membership } from "@ucch/protocol";
import {
  decide,
  type DecisionContext,
  type DecisionState,
  type ProjectSnapshot,
  type ThreadSnapshot,
  type TurnSnapshot,
  type WorkspaceSnapshot,
} from "./decide.js";

const USER = "11111111-1111-1111-1111-111111111111";
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

const OWNER: Membership = { role: "owner", canCreateProject: null, canCreateSession: null };
const member = (over: Partial<Membership> = {}): Membership => ({
  role: "member",
  canCreateProject: null,
  canCreateSession: null,
  ...over,
});

const workspace = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  id: WORKSPACE,
  credentialPolicy: "member",
  membership: OWNER,
  ...over,
});

const project = (over: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  id: PROJECT,
  hash: "abcdef123456",
  workspaceId: WORKSPACE,
  containerState: "running",
  defaultBranch: "main",
  ...over,
});

const thread = (over: Partial<ThreadSnapshot> = {}): ThreadSnapshot => ({
  id: THREAD,
  projectId: PROJECT,
  status: "idle",
  provider: null,
  credentialSource: null,
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

/** A state naming a project comes with the caller's owner membership unless it says otherwise. */
function run(state: DecisionState, command: Command) {
  const withWorkspace = state.project && !("workspace" in state) ? { ...state, workspace: workspace() } : state;
  return decide(withWorkspace, command, ctx);
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

  it("records a project with no repository as having none", () => {
    // The New repository tab: no URL at all, which the clone reactor reads as
    // "initialise one" rather than as a missing field.
    const d = run({ workspace: workspace() }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      name: "my-new-app",
    });
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: "project.created", name: "my-new-app", repoUrl: null, defaultBranch: "main" }],
    });
  });

  it("refuses a project that has neither a repository nor a name", () => {
    // There is nothing left to derive a name from, and a project called ""
    // is worse than a refused command.
    const d = run({ workspace: workspace() }, { type: "project.create", workspaceId: WORKSPACE });
    expect(d).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("starts an empty project on the branch it was given", () => {
    const d = run({ workspace: workspace() }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      name: "trunk",
      branch: "develop",
    });
    expect(d).toMatchObject({ ok: true, events: [{ repoUrl: null, defaultBranch: "develop" }] });
  });

  it("reads a project with no mode as development", () => {
    const d = run({ workspace: workspace() }, { type: "project.create", workspaceId: WORKSPACE, name: "app" });
    expect(d).toMatchObject({ ok: true, events: [{ mode: "development", database: null }] });
  });

  it("records the database a development project asks for", () => {
    const d = run({ workspace: workspace() }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      name: "app",
      mode: "development",
      database: { engine: "mysql", name: "app_dev" },
    });
    expect(d).toMatchObject({ ok: true, events: [{ database: { engine: "mysql", name: "app_dev" } }] });
  });

  it.each(["research", "creative_design"] as const)("refuses a database on a %s project", (mode) => {
    const d = run({ workspace: workspace() }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      name: "app",
      mode,
      database: { engine: "postgresql", name: "app_dev" },
    });
    expect(d).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  // The workspace boundary has to be enforced, not advisory: without these
  // two checks a caller could drop a project into somebody else's workspace.
  it("refuses a workspace the caller is not a member of", () => {
    const d = run({ workspace: workspace({ membership: null }) }, {
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
    const d = run({ project: project(), workspace: workspace({ membership: null }) }, {
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

  // A Claude Code session cannot be resumed by Codex, or by the native loop.
  it("refuses a different provider once the thread is bound to one", () => {
    const d = run({ project: project(), thread: thread({ provider: "claude" }) }, {
      type: "thread.send",
      threadId: THREAD,
      text: "hi",
      provider: "codex",
    });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((d as { error: { message: string } }).error.message).toMatch(/runs on claude/);
  });

  it("accepts the bound provider, or no provider at all", () => {
    for (const provider of ["claude", undefined] as const) {
      const d = run({ project: project(), thread: thread({ provider: "claude" }) }, {
        type: "thread.send",
        threadId: THREAD,
        text: "hi",
        ...(provider ? { provider } : {}),
      });
      expect(d).toMatchObject({ ok: true });
    }
  });

  it("lets an unbound thread pick any provider", () => {
    const d = run({ project: project(), thread: thread() }, {
      type: "thread.send",
      threadId: THREAD,
      text: "hi",
      provider: "codex",
    });
    expect(d).toMatchObject({ ok: true });
  });

  it("records the research mode on the message", () => {
    const d = run({ project: project(), thread: thread() }, {
      type: "thread.send",
      threadId: THREAD,
      text: "what changed in next 15?",
      mode: "research",
    });
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: "user.message", mode: "research" }],
    });
  });

  // On a CLI provider the reactor runs the research first and hands the CLI
  // the brief, so the mode is allowed on any thread -- bound ones included.
  it("allows research on a CLI provider, requested or bound", () => {
    const requested = run({ project: project(), thread: thread() }, {
      type: "thread.send",
      threadId: THREAD,
      text: "hi",
      mode: "research",
      provider: "claude",
    });
    expect(requested).toMatchObject({
      ok: true,
      events: [{ type: "user.message", mode: "research" }],
    });

    const bound = run({ project: project(), thread: thread({ provider: "codex" }) }, {
      type: "thread.send",
      threadId: THREAD,
      text: "hi",
      mode: "research",
    });
    expect(bound).toMatchObject({ ok: true, events: [{ mode: "research" }] });
  });
});

describe("thread.cancel", () => {
  it("records the request while the turn is running", () => {
    const d = run({ project: project(), thread: thread({ status: "running" }) }, {
      type: "thread.cancel",
      threadId: THREAD,
    });
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: "thread.cancel_requested", threadId: THREAD }],
    });
  });

  it.each(["idle", "cancelling", "error"] as const)("refuses while a thread is %s", (status) => {
    const d = run({ project: project(), thread: thread({ status }) }, {
      type: "thread.cancel",
      threadId: THREAD,
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

describe("thread ownership", () => {
  const cases: Command[] = [
    { type: "thread.cancel", threadId: THREAD },
    { type: "thread.permission_reply", threadId: THREAD, requestId: "r1", behavior: "allow" },
    { type: "thread.revert", threadId: THREAD, turnId: TURN },
    { type: "thread.fork", threadId: THREAD, turnId: TURN },
  ];

  it.each(cases)("refuses $type on another user's thread", (command) => {
    const d = run(
      {
        project: project(),
        workspace: workspace({ membership: null }),
        thread: thread({ status: "running" }),
        turn: turn(),
      },
      command,
    );
    expect(d).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it.each(cases)("refuses $type when the project is unknown", (command) => {
    const d = run({ thread: thread({ status: "running" }), turn: turn() }, command);
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

describe("workspace paths", () => {
  // normalizeWorkspacePath itself is tested in @ucch/protocol; this is the
  // one thing decide() is responsible for -- refusing the command.
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

describe("workspace roles", () => {
  it.each([
    ["viewer", member({ role: "viewer" })],
    ["member with project creation turned off", member({ canCreateProject: false })],
  ])("refuses project.create for a %s", (_label, membership) => {
    const d = run({ workspace: workspace({ membership }) }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      name: "app",
    });
    expect(d).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("lets a viewer with the override create a project", () => {
    const d = run({ workspace: workspace({ membership: member({ role: "viewer", canCreateProject: true }) }) }, {
      type: "project.create",
      workspaceId: WORKSPACE,
      name: "app",
    });
    expect(d).toMatchObject({ ok: true });
  });

  it("refuses thread.create when session creation is turned off", () => {
    const d = run(
      { project: project(), workspace: workspace({ membership: member({ canCreateSession: false }) }) },
      { type: "thread.create", projectId: PROJECT },
    );
    expect(d).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("refuses thread.send for a viewer", () => {
    const d = run(
      { project: project(), thread: thread(), workspace: workspace({ membership: member({ role: "viewer" }) }) },
      { type: "thread.send", threadId: THREAD, text: "hi" },
    );
    expect(d).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("refuses project.delete for a member", () => {
    const d = run(
      { project: project(), workspace: workspace({ membership: member() }) },
      { type: "project.delete", projectId: PROJECT },
    );
    expect(d).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("records who started a thread", () => {
    const d = run(
      { project: project(), workspace: workspace({ membership: member() }) },
      { type: "thread.create", projectId: PROJECT },
    );
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: "thread.created", createdByUserId: USER, credentialSource: "member" }],
    });
  });

  it.each([
    ["member", undefined, "member"],
    ["workspace", "member", "workspace"],
    ["either", undefined, "member"],
    ["either", "workspace", "workspace"],
  ] as const)("binds credentials under policy %s (asked %s) to %s", (policy, requested, expected) => {
    const d = run(
      { project: project(), workspace: workspace({ credentialPolicy: policy }) },
      { type: "thread.create", projectId: PROJECT, ...(requested ? { credentialSource: requested } : {}) },
    );
    expect(d).toMatchObject({ ok: true, events: [{ type: "thread.created", credentialSource: expected }] });
  });
});
