import { describe, expect, it } from "vitest";
import { Command, REQUIRED_SCOPE, type Membership } from "@ucch/protocol";
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

  // Two concurrent turns would interleave edits to one working tree. A
  // queued thread has a message whose turn is about to open.
  it.each(["queued", "running", "cancelling"] as const)("refuses while a turn is %s", (status) => {
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

  // With OMP_ENABLED a "Custom" thread is bound to OMP, and the composer
  // still names the native loop until it reloads.
  it("takes a native request on an OMP thread as the same Custom choice", () => {
    const d = run({ project: project(), thread: thread({ provider: "omp" }) }, {
      type: "thread.send",
      threadId: THREAD,
      text: "hi",
      provider: "native",
    });
    expect(d).toMatchObject({ ok: true });
  });

  it("still refuses OMP on a thread bound to the native loop, or another CLI on an OMP one", () => {
    for (const [bound, provider] of [
      ["native", "omp"],
      ["omp", "claude"],
    ] as const) {
      const d = run({ project: project(), thread: thread({ provider: bound }) }, {
        type: "thread.send",
        threadId: THREAD,
        text: "hi",
        provider,
      });
      expect(d).toMatchObject({ ok: false, error: { code: "conflict" } });
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

describe("thread.update", () => {
  it("records only the fields given", () => {
    const d = run({ project: project(), thread: thread() }, { type: "thread.update", threadId: THREAD, pinned: true });
    expect(d).toEqual({ ok: true, events: [{ type: "thread.updated", threadId: THREAD, pinned: true }] });
    const r = run({ project: project(), thread: thread({ status: "running" }) }, {
      type: "thread.update",
      threadId: THREAD,
      title: "Fix the build",
      archived: false,
    });
    expect(r).toEqual({ ok: true, events: [{ type: "thread.updated", threadId: THREAD, title: "Fix the build", archived: false }] });
  });

  it("refuses an update that changes nothing", () => {
    expect(run({ project: project(), thread: thread() }, { type: "thread.update", threadId: THREAD })).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
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

  // Stopped before it opens: the reactor dequeues the turn instead.
  it("records the request while the message is still queued", () => {
    const d = run({ project: project(), thread: thread({ status: "queued" }) }, {
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

describe("thread.compact and thread.handoff", () => {
  it.each([
    ["thread.compact", "compact"],
    ["thread.handoff", "handoff"],
  ] as const)("%s claims an idle OMP thread for its method, with the focus", (type, method) => {
    const d = run({ project: project(), thread: thread({ provider: "omp" }) }, { type, threadId: THREAD, focus: "the parser" });
    expect(d).toEqual({ ok: true, events: [{ type: "thread.compaction_requested", threadId: THREAD, method, focus: "the parser" }] });
    // And without one.
    expect(run({ project: project(), thread: thread({ provider: "omp", status: "error" }) }, { type, threadId: THREAD })).toEqual({
      ok: true,
      events: [{ type: "thread.compaction_requested", threadId: THREAD, method }],
    });
  });

  it.each(["claude", "codex", "native", null] as const)("refuses a thread on %s", (provider) => {
    const d = run({ project: project(), thread: thread({ provider }) }, { type: "thread.compact", threadId: THREAD });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it.each(["queued", "running", "cancelling"] as const)("refuses while the thread is %s", (status) => {
    const d = run({ project: project(), thread: thread({ provider: "omp", status }) }, { type: "thread.handoff", threadId: THREAD });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("busy") } });
  });

  it.each(["claude", "codex", "native"] as const)("hands a thread on %s over on its own harness", (provider) => {
    const d = run({ project: project(), thread: thread({ provider }) }, { type: "thread.handoff", threadId: THREAD, focus: "the parser" });
    expect(d).toEqual({
      ok: true,
      events: [
        {
          type: "thread.harness_switch_requested",
          threadId: THREAD,
          fromProvider: provider,
          targetProvider: provider,
          focus: "the parser",
          reason: "context",
        },
      ],
    });
  });

  it("refuses a handover on a thread that has never run, or is busy", () => {
    expect(run({ project: project(), thread: thread({ provider: null }) }, { type: "thread.handoff", threadId: THREAD })).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    expect(
      run({ project: project(), thread: thread({ provider: "claude", status: "running" }) }, { type: "thread.handoff", threadId: THREAD }),
    ).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("busy") } });
  });
});

describe("thread.handoff_to", () => {
  it.each(["claude", "codex", "omp", "native"] as const)("claims an idle thread for a handoff to %s, with the focus", (target) => {
    const d = run(
      { project: project(), thread: thread({ provider: "claude" }) },
      { type: "thread.handoff_to", threadId: THREAD, targetProvider: target, focus: "the migration" },
    );
    expect(d).toEqual({
      ok: true,
      events: [{ type: "thread.handoff_requested", threadId: THREAD, targetProvider: target, focus: "the migration" }],
    });
  });

  it("takes a thread whose last turn failed: a usage limit is what a handoff is for", () => {
    const d = run({ project: project(), thread: thread({ provider: "codex", status: "error" }) }, {
      type: "thread.handoff_to",
      threadId: THREAD,
      targetProvider: "omp",
    });
    expect(d).toEqual({ ok: true, events: [{ type: "thread.handoff_requested", threadId: THREAD, targetProvider: "omp" }] });
  });

  it("carries the server's own handoff on a limit: the message that failed, and why", () => {
    const d = run({ project: project(), thread: thread({ provider: "claude", status: "error" }) }, {
      type: "thread.handoff_to",
      threadId: THREAD,
      targetProvider: "codex",
      message: "Add the retry test",
      reason: "limit",
    });
    expect(d).toEqual({
      ok: true,
      events: [
        { type: "thread.handoff_requested", threadId: THREAD, targetProvider: "codex", message: "Add the retry test", reason: "limit" },
      ],
    });
  });

  it("refuses a thread that has never run", () => {
    const d = run({ project: project(), thread: thread() }, { type: "thread.handoff_to", threadId: THREAD, targetProvider: "codex" });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("no conversation") } });
  });

  it.each(["queued", "running", "cancelling"] as const)("refuses while the thread is %s", (status) => {
    const d = run({ project: project(), thread: thread({ provider: "omp", status }) }, {
      type: "thread.handoff_to",
      threadId: THREAD,
      targetProvider: "claude",
    });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("busy") } });
  });

  it.each(["creating", "error"] as const)("refuses a session whose worktree is %s", (worktreeState) => {
    const d = run({ project: project(), thread: thread({ provider: "omp", worktreeState }) }, {
      type: "thread.handoff_to",
      threadId: THREAD,
      targetProvider: "claude",
    });
    expect(d).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("worktree") } });
  });

  it("refuses a member who cannot start a session", () => {
    const d = run(
      { project: project(), workspace: workspace({ membership: member({ canCreateSession: false }) }), thread: thread({ provider: "omp" }) },
      { type: "thread.handoff_to", threadId: THREAD, targetProvider: "claude" },
    );
    expect(d).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("thread.create in another thread's worktree", () => {
  const source = (over: Partial<ThreadSnapshot> = {}) =>
    thread({ provider: "omp", hash: "s0urce0hash0", branch: "ucch/s0urce0hash0", baseBranch: "main", worktreeState: "ready", ...over });

  it("takes the source's worktree and branch, naming the folder by the source's hash", () => {
    const d = run({ project: project(), thread: source() }, { type: "thread.create", projectId: PROJECT, title: "Continued: x", worktreeOf: THREAD });
    expect(d).toEqual({
      ok: true,
      events: [
        {
          type: "thread.created",
          threadId: NEW_ID,
          projectId: PROJECT,
          title: "Continued: x",
          createdByUserId: USER,
          credentialSource: "member",
          hash: "abcdef123456",
          worktreeOf: THREAD,
          baseBranch: "main",
          branch: "ucch/s0urce0hash0",
          treeHash: "s0urce0hash0",
        },
      ],
    });
  });

  it("keeps naming the first folder down a chain of handoffs", () => {
    const d = run({ project: project(), thread: source({ hash: "m1ddle0hash0", treeHash: "s0urce0hash0" }) }, {
      type: "thread.create",
      projectId: PROJECT,
      worktreeOf: THREAD,
    });
    expect(d).toMatchObject({ ok: true, events: [{ treeHash: "s0urce0hash0", branch: "ucch/s0urce0hash0" }] });
  });

  it("shares the project's checkout with a thread that has no worktree", () => {
    const d = run({ project: project(), thread: source({ branch: null, baseBranch: null, worktreeState: null }) }, {
      type: "thread.create",
      projectId: PROJECT,
      worktreeOf: THREAD,
    });
    expect(d).toMatchObject({ ok: true });
    const [event] = (d as { events: Record<string, unknown>[] }).events;
    expect(event).toMatchObject({ type: "thread.created", worktreeOf: THREAD });
    expect(event).not.toHaveProperty("branch");
    expect(event).not.toHaveProperty("treeHash");
  });

  it("refuses a source in another project, a missing one, or a branch of its own beside it", () => {
    expect(run({ project: project(), thread: source({ projectId: NEW_ID }) }, { type: "thread.create", projectId: PROJECT, worktreeOf: THREAD })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(run({ project: project() }, { type: "thread.create", projectId: PROJECT, worktreeOf: THREAD })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(
      run({ project: project(), thread: source() }, { type: "thread.create", projectId: PROJECT, worktreeOf: THREAD, baseBranch: "main" }),
    ).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("refuses a worktree that is not there yet", () => {
    const d = run({ project: project(), thread: source({ worktreeState: "creating" }) }, { type: "thread.create", projectId: PROJECT, worktreeOf: THREAD });
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
    { type: "thread.compact", threadId: THREAD },
    { type: "thread.handoff", threadId: THREAD },
    { type: "thread.handoff_to", threadId: THREAD, targetProvider: "claude" },
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

  const create = { type: "terminal.create", projectId: PROJECT, terminalId: "t1", cols: 80, rows: 24 } as const;

  it("accepts a command terminal that names its command", () => {
    const d = run({ project: project() }, { ...create, program: "command", commandId: "dev" });
    expect(d).toMatchObject({ ok: true });
  });

  it("refuses a command terminal without a command", () => {
    const d = run({ project: project() }, { ...create, program: "command" });
    expect(d).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it.each([undefined, "shell", "claude-login"] as const)("refuses a command id on a %s terminal", (program) => {
    const d = run({ project: project() }, { ...create, ...(program ? { program } : {}), commandId: "dev" });
    expect(d).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("refuses a command terminal on the workspace's credentials", () => {
    const d = run(
      { project: project() },
      { ...create, program: "command", commandId: "dev", credentialWorkspaceId: WORKSPACE },
    );
    expect(d).toMatchObject({ ok: false, error: { code: "invalid" } });
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

describe("review.run", () => {
  it("records the request for the reactor, on the checkout or a session's worktree", () => {
    expect(run({ project: project() }, { type: "review.run", projectId: PROJECT, scope: "uncommitted", focus: "  the parser " })).toEqual({
      ok: true,
      events: [
        {
          type: "review.requested",
          projectId: PROJECT,
          reviewId: NEW_ID,
          threadId: null,
          scope: "uncommitted",
          ref: null,
          focus: "the parser",
          requestedBy: USER,
        },
      ],
    });
    const d = run({ project: project(), thread: thread({ worktreeState: "ready" }) }, { type: "review.run", projectId: PROJECT, threadId: THREAD, scope: "commit", ref: "abc123" });
    expect(d).toMatchObject({ ok: true, events: [{ type: "review.requested", threadId: THREAD, scope: "commit", ref: "abc123" }] });
    // A review reads the tree from the server: the container may be stopped.
    expect(run({ project: project({ containerState: "stopped" }) }, { type: "review.run", projectId: PROJECT, scope: "branch" })).toMatchObject({ ok: true });
  });

  it("refuses a viewer, a stranger, another project's session, and a worktree not ready", () => {
    const command: Command = { type: "review.run", projectId: PROJECT, scope: "uncommitted" };
    expect(run({ project: project(), workspace: workspace({ membership: member({ role: "viewer" }) }) }, command)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(run({ project: project(), workspace: workspace({ membership: null }) }, command)).toMatchObject({ ok: false, error: { code: "not_found" } });
    const inThread: Command = { ...command, threadId: THREAD };
    expect(run({ project: project(), thread: thread({ projectId: NEW_ID }) }, inThread)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(run({ project: project() }, inThread)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(run({ project: project(), thread: thread({ worktreeState: "creating" }) }, inThread)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("is billed, so it needs the exec scope; a ref may not be an option", () => {
    expect(REQUIRED_SCOPE["review.run"]).toBe("exec");
    expect(Command.safeParse({ type: "review.run", projectId: PROJECT, scope: "commit", ref: "--output=/x" }).success).toBe(false);
  });
});

describe("thread.switch_harness", () => {
  const switching = (over: Partial<Extract<Command, { type: "thread.switch_harness" }>> = {}): Command => ({
    type: "thread.switch_harness",
    threadId: THREAD,
    targetProvider: "codex",
    ...over,
  });

  it("records the switch of a bound, idle thread, with what is sent after it", () => {
    const d = run(
      { project: project(), thread: thread({ provider: "claude" }) },
      switching({ model: "gpt-6-sol", message: "Add the test", reason: "limit" }),
    );
    expect(d).toEqual({
      ok: true,
      events: [
        {
          type: "thread.harness_switch_requested",
          threadId: THREAD,
          fromProvider: "claude",
          targetProvider: "codex",
          model: "gpt-6-sol",
          message: "Add the test",
          reason: "limit",
        },
      ],
    });
  });

  it("refuses a thread that has not run, one already on the harness, and a busy one", () => {
    expect(run({ project: project(), thread: thread() }, switching())).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(run({ project: project(), thread: thread({ provider: "codex" }) }, switching())).toMatchObject({ ok: false });
    // Custom is one choice, whichever runtime serves it.
    expect(run({ project: project(), thread: thread({ provider: "omp" }) }, switching({ targetProvider: "native" }))).toMatchObject({
      ok: false,
    });
    expect(run({ project: project(), thread: thread({ provider: "claude", status: "running" }) }, switching())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("leaves a subagent's session to the server", () => {
    const child = thread({ provider: "claude", parentThreadId: "99999999-9999-4999-8999-999999999999" });
    expect(run({ project: project(), thread: child }, switching())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const internal = decide({ project: project(), thread: child, workspace: workspace() }, switching(), { ...ctx, internal: true });
    expect(internal).toMatchObject({ ok: true });
  });
});

describe("thread.create for a subagent", () => {
  const create: Command = { type: "thread.create", projectId: PROJECT, title: "Research", parentThreadId: THREAD };

  it("is the server's alone", () => {
    expect(run({ project: project(), thread: thread() }, create)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("makes a session in its parent's folder, linked to it", () => {
    const d = decide(
      { project: project(), thread: thread({ branch: "ucch/abc", worktreeState: "ready", hash: "parent123456" }), workspace: workspace() },
      create,
      { ...ctx, internal: true },
    );
    expect(d).toMatchObject({
      ok: true,
      events: [
        {
          type: "thread.created",
          threadId: NEW_ID,
          title: "Research",
          worktreeOf: THREAD,
          parentThreadId: THREAD,
          branch: "ucch/abc",
          treeHash: "parent123456",
        },
      ],
    });
  });

  it("refuses a subagent of a subagent", () => {
    const d = decide(
      { project: project(), thread: thread({ parentThreadId: "99999999-9999-4999-8999-999999999999" }), workspace: workspace() },
      create,
      { ...ctx, internal: true },
    );
    expect(d).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});

describe("agent session messages", () => {
  const source = { id: NEW_ID, projectId: PROJECT, hash: "abcdef123456" };
  const command: Command = { type: "thread.agent_message", threadId: THREAD, fromThreadId: NEW_ID, text: "Please review the parser", depth: 0 };
  const state = { workspace: workspace(), project: project(), thread: thread(), messageSource: source };
  it("records an authenticated same-project agent message", () => {
    expect(decide(state, command, { ...ctx, internal: true })).toMatchObject({ ok: true, events: [{ type: "agent.session_message", fromThreadId: NEW_ID, threadId: THREAD, text: command.text }] });
  });
  it("refuses forged senders and cross-project sources", () => {
    expect(decide(state, command, ctx)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(decide({ ...state, messageSource: { ...source, projectId: WORKSPACE } }, command, { ...ctx, internal: true })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(decide({ ...state, messageSource: undefined }, command, { ...ctx, internal: true })).toMatchObject({ ok: false });
  });
  it("requires execution rights even for internal deliveries", () => {
    expect(decide({ ...state, workspace: workspace({ membership: member({ role: "viewer" }) }) }, command, { ...ctx, internal: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("refuses client-supplied delivery receipts", () => {
    expect(decide(state, { type: "thread.send", threadId: THREAD, text: "x", agentMessageIds: [NEW_ID] }, ctx)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("allows stopping children after the parent's turn has ended", () => {
    expect(decide({ ...state, thread: thread({ hasActiveChildren: true }) }, { type: "thread.cancel", threadId: THREAD }, ctx)).toMatchObject({ ok: true, events: [{ type: "thread.cancel_requested" }] });
  });
});

describe("native subagent follow-up", () => {
  const state = { workspace: workspace(), project: project(), thread: thread({ provider: "codex" }), subagent: { id: "parent:/root/alpha", provider: "codex" } };
  const command = { type: "thread.send", threadId: THREAD, text: "Edit your current task", subagentId: "parent:/root/alpha", provider: "codex" } as const;
  it("records the recipient with the message", () => {
    expect(run(state, command)).toMatchObject({ ok: true, events: [{ type: "user.message", subagentId: command.subagentId, text: command.text }] });
  });
  it("rejects other-thread IDs and independent sessions", () => {
    expect(run(state, { ...command, subagentId: "other:/root/alpha" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(run({ ...state, subagent: { ...state.subagent, childThreadId: NEW_ID } }, command)).toMatchObject({ ok: false });
  });
  it("uses the normal busy guard rather than racing the parent harness", () => {
    expect(run({ ...state, thread: thread({ provider: "codex", status: "running" }) }, command)).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});

describe("Claude Code subagent follow-up", () => {
  const state = { workspace: workspace(), project: project(), thread: thread({ provider: "claude" }), subagent: { id: "toolu_agent", resumeHandle: "a454c450ac8feab62" } };
  const command = { type: "thread.send", threadId: THREAD, text: "Now check the auth routes", subagentId: "toolu_agent", provider: "claude" } as const;
  it("records the handle from the subagent's own events with the message", () => {
    const decided = run(state, command);
    expect(decided).toMatchObject({ ok: true, events: [{ type: "user.message", subagentId: "toolu_agent", subagentHandle: "a454c450ac8feab62", text: command.text }] });
  });
  it("rejects a subagent with no handle, a ucch_agent one, another subagent, or a thread now on another harness", () => {
    expect(run({ ...state, subagent: { id: "toolu_agent" } }, command)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(run({ ...state, subagent: { ...state.subagent, childThreadId: NEW_ID } }, command)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(run({ ...state, subagent: { ...state.subagent, provider: "claude" } }, command)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(run(state, { ...command, subagentId: "toolu_other" })).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(run({ ...state, thread: thread({ provider: "codex" }) }, { ...command, provider: "codex" })).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
  it("never takes a handle from the client", () => {
    const forged = { ...command, subagentHandle: "evil" } as unknown as typeof command;
    const decided = run(state, forged);
    expect(decided).toMatchObject({ ok: true, events: [{ subagentHandle: "a454c450ac8feab62" }] });
  });
});

describe("subscription accounts", () => {
  const WORK = "88888888-8888-8888-8888-888888888888";
  const OTHER_USER = "99999999-9999-9999-9999-999999999999";
  const profile = (over: Partial<NonNullable<DecisionState["profile"]>> = {}): NonNullable<DecisionState["profile"]> => ({
    id: WORK,
    subject: USER,
    provider: "claude",
    context: "work",
    isDefault: false,
    ...over,
  });
  const switching = (over: Partial<Extract<Command, { type: "thread.switch_harness" }>> = {}): Command => ({
    type: "thread.switch_harness",
    threadId: THREAD,
    targetProvider: "claude",
    targetProfileId: WORK,
    ...over,
  });
  const bound = thread({ provider: "claude", createdByUserId: USER });

  it("never lets an automatic switch move to another account of the same provider", () => {
    expect(run({ project: project(), thread: bound, profile: profile() }, switching({ auto: true }))).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
  });

  it("lets a person move the session to another account of the same provider", () => {
    const d = run({ project: project(), thread: bound, profile: profile() }, switching({ reason: "limit" }));
    expect(d).toMatchObject({
      ok: true,
      events: [{ type: "thread.harness_switch_requested", fromProvider: "claude", targetProvider: "claude", toProfileId: WORK }],
    });
  });

  it("refuses a move to the account the session is already on", () => {
    expect(run({ project: project(), thread: { ...bound, profileId: WORK }, profile: profile() }, switching())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
    // Unbound runs on the Default account.
    expect(run({ project: project(), thread: bound, profile: profile({ isDefault: true }) }, switching())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("still lets an automatic switch go to another provider", () => {
    const d = run({ project: project(), thread: bound }, switching({ targetProvider: "codex", targetProfileId: undefined, auto: true }));
    expect(d).toMatchObject({ ok: true, events: [{ type: "thread.harness_switch_requested", targetProvider: "codex", auto: true }] });
  });

  it("refuses another person's account, the workspace's account on a member session, and the wrong provider", () => {
    expect(run({ project: project(), thread: bound, profile: profile({ subject: OTHER_USER }) }, switching())).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(run({ project: project(), thread: bound, profile: profile({ subject: `ws-${WORKSPACE}` }) }, switching())).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(run({ project: project(), thread: bound, profile: profile({ provider: "codex" }) }, switching())).toMatchObject({
      ok: false,
      error: { code: "invalid" },
    });
    expect(run({ project: project(), thread: bound }, switching())).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("takes the workspace's accounts for a session on its subscription", () => {
    const state = {
      project: project(),
      workspace: workspace({ credentialPolicy: "workspace" }),
      thread: bound,
      profile: profile({ subject: `ws-${WORKSPACE}` }),
    };
    expect(run(state, switching())).toMatchObject({ ok: true });
  });

  it("refuses an account whose context the project does not accept", () => {
    const state = { project: project({ requiredContext: "work" }), thread: bound, profile: profile({ context: "personal" }) };
    expect(run(state, switching())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const create: Command = { type: "thread.create", projectId: PROJECT, profileId: WORK };
    expect(run(state, create)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("starts a session bound to the starter's account", () => {
    const d = run({ project: project(), profile: profile() }, { type: "thread.create", projectId: PROJECT, profileId: WORK });
    expect(d).toMatchObject({ ok: true, events: [{ type: "thread.created", profileId: WORK, createdByUserId: USER }] });
  });

  it("only lets a sign-in terminal name an account", () => {
    const shell: Command = { type: "terminal.create", projectId: PROJECT, terminalId: NEW_ID, cols: 80, rows: 24, profileId: WORK };
    expect(run({ project: project() }, shell)).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});
