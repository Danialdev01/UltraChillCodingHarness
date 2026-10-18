import { describe, expect, it } from "vitest";
import { threads, turns, type Transaction } from "@ucch/db";
import type { DomainEvent } from "@ucch/protocol";
import { applyProjection } from "./engine.js";
import { decide, type DecisionContext } from "./decide.js";

const USER = "11111111-1111-1111-1111-111111111111";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "55555555-5555-5555-5555-555555555555";

/**
 * A transaction double that records statements instead of issuing them.
 *
 * There is no Postgres in the test environment, and standing one up would
 * make the suite unrunnable on a laptop for the sake of three assertions.
 * What matters here is which statements the projection issues for which
 * event, and that is exactly what this records.
 */
function recorder() {
  const statements: { op: "insert" | "update"; table: string; values: Record<string, unknown> }[] =
    [];

  const name = (table: unknown): string =>
    table === turns ? "turns" : table === threads ? "threads" : "other";

  // `.values()` and `.where()` are awaited at the call site, and previews
  // chain `.onConflictDoNothing()` onto the promise, so the double returns a
  // thenable that carries the same method.
  const settled = () => {
    const promise = Promise.resolve([]) as Promise<never[]> & { onConflictDoNothing(): unknown };
    promise.onConflictDoNothing = () => promise;
    return promise;
  };

  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        statements.push({ op: "insert", table: name(table), values });
        return settled();
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          statements.push({ op: "update", table: name(table), values });
          return settled();
        },
      }),
    }),
  };

  return { statements, tx: tx as unknown as Transaction };
}

const apply = async (batch: DomainEvent[]) => {
  const { statements, tx } = recorder();
  await applyProjection(tx, batch, { userId: USER });
  return statements;
};

const ctx: DecisionContext = {
  userId: USER,
  now: new Date("2026-09-04T00:00:00Z"),
  newId: () => TURN,
  newHash: () => "abcdef123456",
};

const project = {
  id: PROJECT,
  hash: "abcdef123456",
  workspaceId: "77777777-7777-7777-7777-777777777777",
  containerState: "running" as const,
  defaultBranch: "main",
};

const workspace = {
  id: "77777777-7777-7777-7777-777777777777",
  credentialPolicy: "member" as const,
  membership: { role: "owner" as const, canCreateProject: null, canCreateSession: null },
};

describe("turn.started", () => {
  // The events one `thread.send` produces: the command's, then the reactor's.
  const send: DomainEvent[] = [
    { type: "user.message", threadId: THREAD, text: "hello" },
    { type: "turn.started", threadId: THREAD, turnId: TURN },
  ];

  it("opens exactly one turn and moves the thread to running", async () => {
    const statements = await apply(send);

    const inserted = statements.filter((s) => s.op === "insert" && s.table === "turns");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.values).toMatchObject({ id: TURN, threadId: THREAD });
    // The ordinal is a sub-select rather than a literal, so it is computed in
    // the same statement that inserts.
    expect(inserted[0]!.values.seq).toBeTruthy();

    expect(statements.filter((s) => s.table === "threads")).toEqual([
      { op: "update", table: "threads", values: { status: "running" } },
    ]);
  });

  it("is what makes the one-turn-at-a-time guard fire", async () => {
    // The two halves of the bug in one test: the projection sets `running`,
    // and `running` is the state the send guard has always been looking for
    // and never once found.
    const status = (await apply(send)).find((s) => s.table === "threads")!.values.status;

    const second = decide(
      {
        project,
        workspace,
        thread: { id: THREAD, projectId: PROJECT, status: status as "running", provider: null, credentialSource: null },
      },
      { type: "thread.send", threadId: THREAD, text: "again" },
      ctx,
    );

    expect(second).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("lets a cancel through, which it never did before", async () => {
    const status = (await apply(send)).find((s) => s.table === "threads")!.values.status;

    const cancel = decide(
      {
        project,
        workspace,
        thread: { id: THREAD, projectId: PROJECT, status: status as "running", provider: null, credentialSource: null },
      },
      { type: "thread.cancel", threadId: THREAD },
      ctx,
    );

    expect(cancel).toMatchObject({
      ok: true,
      events: [{ type: "thread.cancel_requested", threadId: THREAD }],
    });
  });
});

describe("thread status", () => {
  it("moves to cancelling on a cancel request, not straight to idle", async () => {
    const statements = await apply([{ type: "thread.cancel_requested", threadId: THREAD }]);
    expect(statements).toEqual([
      { op: "update", table: "threads", values: { status: "cancelling" } },
    ]);
  });

  it("returns to idle when the turn completes", async () => {
    const statements = await apply([
      {
        type: "agent.turn_completed",
        threadId: THREAD,
        turnId: TURN,
        stopReason: "cancelled",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        costUsd: 0,
      },
    ]);

    // A cancellation is not a failure: the thread goes back to idle, so the
    // next message is accepted rather than blocked behind an error state.
    expect(statements).toEqual([
      { op: "update", table: "turns", values: expect.objectContaining({ stopReason: "cancelled" }) },
      { op: "update", table: "threads", values: { status: "idle" } },
    ]);
  });

  it("binds the thread to the turn's provider without overwriting one", async () => {
    const statements = await apply([
      { type: "turn.started", threadId: THREAD, turnId: TURN, provider: "claude" },
    ]);
    const updates = statements.filter((s) => s.table === "threads");
    expect(updates[0]).toEqual({ op: "update", table: "threads", values: { status: "running" } });
    // A coalesce, not a literal: an already-bound thread keeps its provider.
    expect(updates[1]?.values.provider).toBeTruthy();
    expect(updates[1]?.values.provider).not.toBe("claude");
  });

  it("stores the CLI session id the moment it is reported", async () => {
    const statements = await apply([
      {
        type: "agent.session_started",
        threadId: THREAD,
        turnId: TURN,
        provider: "codex",
        sessionId: "thread-abc",
      },
    ]);
    expect(statements).toEqual([
      {
        op: "update",
        table: "threads",
        values: { provider: "codex", providerSessionId: "thread-abc" },
      },
    ]);
  });

  it("goes to error when the turn fails", async () => {
    const statements = await apply([
      { type: "agent.turn_failed", threadId: THREAD, turnId: TURN, error: "boom" },
    ]);
    expect(statements.at(-1)).toEqual({
      op: "update",
      table: "threads",
      values: { status: "error" },
    });
  });
});

describe("applyProjection", () => {
  it("refuses to own a new project when there is no actor", async () => {
    const { tx } = recorder();
    await expect(
      applyProjection(
        tx,
        [
          {
            type: "project.created",
            projectId: PROJECT,
            workspaceId: "77777777-7777-7777-7777-777777777777",
            hash: "abcdef123456",
            name: "x",
            repoUrl: "https://example.com/x.git",
            defaultBranch: "main",
          },
        ],
        null,
      ),
    ).rejects.toThrow(/actor/);
  });

  it("ignores events that have no read model", async () => {
    expect(
      await apply([{ type: "agent.text_delta", threadId: THREAD, turnId: TURN, text: "hi" }]),
    ).toEqual([]);
  });
});
