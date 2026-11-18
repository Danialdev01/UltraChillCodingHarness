import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ucch/db";
import type { DomainEvent } from "@ucch/protocol";
import type { EventStore } from "./eventstore.js";
import type { ProjectGit } from "./project-git.js";
import { reviveSession } from "./session-revive.js";

const THREAD = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const MEMBER = "55555555-5555-4555-8555-555555555555";
const principal = (userId = OWNER) => ({ userId, sessionId: "s", scopes: ["exec"], internal: false }) as never;

function thread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD, projectId: PROJECT, hash: "abcdefabcdef", treeHash: null, branch: null, baseBranch: null,
    settleBaseBranch: null, archivedAt: null, settleState: null, worktreeState: null, ...overrides,
  };
}

function setup(row: Record<string, unknown>, membership: unknown[] = []) {
  const results = [[{ thread: row, workspaceId: WORKSPACE, owner: OWNER }], membership];
  const chain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const key of ["from", "innerJoin", "where"]) c[key] = () => c;
    c.limit = () => Promise.resolve(result);
    return c;
  };
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: vi.fn(() => chain(results.shift() ?? [])),
    update: vi.fn(() => ({ set: (values: Record<string, unknown>) => ({ where: async () => updates.push(values) }) })),
  } as unknown as Database;
  const appended: DomainEvent[] = [];
  const store = { append: vi.fn(async (_target: unknown, batch: DomainEvent[]) => { appended.push(...batch); return []; }) } as unknown as EventStore;
  const restoreWorktree = vi.fn(async () => "/tree");
  return { deps: { db, store, projectGit: { restoreWorktree } as unknown as ProjectGit }, updates, appended, restoreWorktree };
}

describe("reviveSession", () => {
  it("does nothing to an active session", async () => {
    const { deps, updates, appended } = setup(thread());
    await reviveSession(deps, principal(), THREAD);
    expect(updates).toEqual([]);
    expect(appended).toEqual([]);
  });

  it("brings an archived session back", async () => {
    const { deps, appended, updates } = setup(thread({ archivedAt: new Date() }));
    await reviveSession(deps, principal(), THREAD);
    expect(appended).toEqual([{ type: "thread.updated", threadId: THREAD, archived: false }]);
    expect(updates).toEqual([]);
  });

  it("clears a session workspace's settled mark without touching git", async () => {
    const { deps, updates, restoreWorktree, appended } = setup(thread({ settleState: "settled" }));
    await reviveSession(deps, principal(), THREAD);
    expect(restoreWorktree).not.toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ settleState: null, settledAt: null })]);
    expect(updates[0]).not.toHaveProperty("worktreeState");
    expect(appended).toEqual([]);
  });

  it("gives a settled project session its worktree back before un-settling it", async () => {
    const { deps, updates, restoreWorktree, appended } = setup(
      thread({ settleState: "settled", worktreeState: "settled", branch: "ucch/abcdefabcdef", baseBranch: "main", settleBaseBranch: "release" }),
    );
    await reviveSession(deps, principal(), THREAD);
    expect(restoreWorktree).toHaveBeenCalledWith(PROJECT, "abcdefabcdef", "ucch/abcdefabcdef", "release");
    expect(updates).toEqual([expect.objectContaining({ settleState: null, worktreeState: "ready" })]);
    expect(appended).toEqual([{ type: "thread.worktree_ready", threadId: THREAD }]);
  });

  it("leaves the session settled when its worktree cannot be restored", async () => {
    const { deps, updates, restoreWorktree } = setup(
      thread({ settleState: "settled", worktreeState: "settled", branch: "ucch/abcdefabcdef", baseBranch: "main" }),
    );
    restoreWorktree.mockRejectedValueOnce(new Error("base branch is gone"));
    await expect(reviveSession(deps, principal(), THREAD)).rejects.toThrow("base branch is gone");
    expect(updates).toEqual([]);
  });

  it("changes nothing for someone who cannot write to the project", async () => {
    const viewer = setup(thread({ archivedAt: new Date(), settleState: "settled" }), [{ role: "viewer", canCreateProject: null, canCreateSession: null }]);
    await reviveSession(viewer.deps, principal(MEMBER), THREAD);
    expect(viewer.updates).toEqual([]);
    expect(viewer.appended).toEqual([]);
    const stranger = setup(thread({ archivedAt: new Date() }), []);
    await reviveSession(stranger.deps, principal(MEMBER), THREAD);
    expect(stranger.appended).toEqual([]);
  });

  it("lets a workspace member who can write revive it", async () => {
    const { deps, appended } = setup(thread({ archivedAt: new Date() }), [{ role: "member", canCreateProject: null, canCreateSession: null }]);
    await reviveSession(deps, principal(MEMBER), THREAD);
    expect(appended).toHaveLength(1);
  });
});
