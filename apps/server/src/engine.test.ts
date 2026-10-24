import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { projectStats, threads, turns, type Database, type Transaction } from "@ucch/db";
import { LIMIT_STOP_REASONS, type DomainEvent } from "@ucch/protocol";
import { applyProjection, OrchestrationEngine, ProjectionConflict } from "./engine.js";
import type { EventStore } from "./eventstore.js";
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
function recorder({ claimed = true }: { claimed?: boolean } = {}) {
  const statements: Statement[] = [];

  const name = (table: unknown): string =>
    table === turns
      ? "turns"
      : table === threads
        ? "threads"
        : table === projectStats
          ? "project_stats"
          : "other";

  // `.values()` and `.where()` are awaited at the call site, and inserts
  // chain `.onConflictDoNothing()` or `.onConflictDoUpdate()` onto the
  // promise, so the double returns a thenable that carries those methods.
  const settled = (statement?: Statement) => {
    const promise = Promise.resolve([]) as Promise<never[]> & {
      onConflictDoNothing(): unknown;
      onConflictDoUpdate(config: { set: Record<string, unknown> }): unknown;
      returning(): Promise<{ id: string }[]>;
    };
    promise.onConflictDoNothing = () => promise;
    promise.onConflictDoUpdate = (config) => {
      if (statement) statement.onConflict = config.set;
      return promise;
    };
    // The rows an update claimed: one, or none when `claimed` is false --
    // the row had already moved on.
    promise.returning = () => Promise.resolve(claimed ? [{ id: THREAD }] : []);
    return promise;
  };

  const tx = {
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        const statement: Statement = { op: "insert", table: name(table), values };
        statements.push(statement);
        return settled(statement);
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          statements.push({ op: "update", table: name(table), values });
          wheres.set(statements.at(-1)!, where as SQL);
          return settled();
        },
      }),
    }),
  };

  return { statements, tx: tx as unknown as Transaction };
}

interface Statement {
  op: "insert" | "update";
  table: string;
  values: Record<string, unknown>;
  /** What an upsert sets on conflict. */
  onConflict?: Record<string, unknown>;
}

/** Each update's `where`, kept off the statement so the tests' `toEqual`s stay as they are. */
const wheres = new WeakMap<Statement, SQL>();

/** A SQL value as Postgres would receive it: text and parameters. */
const dialect = new PgDialect();
const rendered = (value: unknown) => {
  const { sql, params } = dialect.sqlToQuery(value as SQL);
  return { sql, params };
};

const apply = async (batch: DomainEvent[], options?: { claimed?: boolean }) => {
  const { statements, tx } = recorder(options);
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

    // The message claims the thread; the turn moves it on.
    expect(statements.filter((s) => s.table === "threads")).toEqual([
      { op: "update", table: "threads", values: { status: "queued" } },
      { op: "update", table: "threads", values: { status: "running" } },
    ]);
  });

  it("is what makes the one-turn-at-a-time guard fire", async () => {
    // The two halves of the bug in one test: the projection sets `running`,
    // and `running` is the state the send guard has always been looking for
    // and never once found.
    const status = (await apply(send)).findLast((s) => s.table === "threads")!.values.status;

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
    const status = (await apply(send)).findLast((s) => s.table === "threads")!.values.status;

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
  it("is claimed by a message, only from idle or error", async () => {
    const statements = await apply([{ type: "user.message", threadId: THREAD, text: "hello" }]);
    expect(statements).toEqual([{ op: "update", table: "threads", values: { status: "queued" } }]);
    const where = rendered(wheres.get(statements[0]!));
    expect(where.sql).toMatch(/"threads"\."id" = \$1 and "threads"\."status" in \(\$2, \$3\)/);
    expect(where.params).toEqual([THREAD, "idle", "error"]);
  });

  it("refuses a message when another one claimed the thread first", async () => {
    // Both sends read `idle`; the second finds the row already queued, and
    // its transaction rolls back with a conflict the engine reports.
    await expect(
      apply([{ type: "user.message", threadId: THREAD, text: "again" }], { claimed: false }),
    ).rejects.toBeInstanceOf(ProjectionConflict);
  });

  it("goes back to idle when a queued message is dequeued, and only then", async () => {
    const statements = await apply([{ type: "turn.dequeued", threadId: THREAD, reason: "cancelled" }]);
    expect(statements).toEqual([{ op: "update", table: "threads", values: { status: "idle" } }]);
    // Never a running turn's thread: a stray dequeue must not free it.
    expect(rendered(wheres.get(statements[0]!)).params).toEqual([THREAD, "queued", "cancelling"]);
  });

  it("moves to cancelling on a cancel request, not straight to idle", async () => {
    const statements = await apply([{ type: "thread.cancel_requested", threadId: THREAD }]);
    expect(statements).toEqual([
      { op: "update", table: "threads", values: { status: "cancelling" } },
    ]);
    // Only while a turn is waiting or running: one that already ended would
    // leave the thread cancelling for good.
    expect(rendered(wheres.get(statements[0]!)).params).toEqual([THREAD, "queued", "running"]);
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
    expect(statements.filter((s) => s.table !== "project_stats")).toEqual([
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
    expect(statements.filter((s) => s.table !== "project_stats").at(-1)).toEqual({
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

describe("project_stats", () => {
  const completed: DomainEvent = {
    type: "agent.turn_completed",
    threadId: THREAD,
    turnId: TURN,
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
    costUsd: 0.25,
  };
  const stats = (statements: Statement[]) => statements.filter((s) => s.table === "project_stats");
  const whereOf = (statement: Statement) => rendered(wheres.get(statement));

  it("starts a project's row at zero", async () => {
    const statements = await apply([
      {
        type: "project.created",
        projectId: PROJECT,
        workspaceId: "77777777-7777-7777-7777-777777777777",
        hash: "abcdef123456",
        name: "x",
        repoUrl: null,
        defaultBranch: "main",
      },
    ]);
    expect(stats(statements)).toEqual([{ op: "insert", table: "project_stats", values: { projectId: PROJECT } }]);
  });

  it("counts a new thread with an upsert that adds one", async () => {
    const [upsert] = stats(await apply([{ type: "thread.created", threadId: THREAD, projectId: PROJECT, title: "t" }]));
    expect(upsert!.values).toEqual({ projectId: PROJECT, threadCount: 1 });
    expect(rendered(upsert!.onConflict!.threadCount).sql).toBe('"project_stats"."thread_count" + 1');
  });

  it("makes a started turn the project's latest, not failed", async () => {
    const [update] = stats(await apply([{ type: "turn.started", threadId: THREAD, turnId: TURN }]));
    expect(update!.values).toMatchObject({ lastTurnId: TURN, lastTurnFailed: false });
    // The project is the thread's, looked up in the same statement.
    expect(whereOf(update!).sql).toContain('select "threads"."project_id" from "threads"');
    expect(whereOf(update!).params).toEqual([THREAD]);
  });

  it("adds a completed turn's tokens and cost, then sets the failed flag if it is still the latest", async () => {
    const statements = await apply([completed]);
    const [sums, flag] = stats(statements);

    // Relative: added in SQL, never read and written back.
    expect(rendered(sums!.values.tokens)).toEqual({ sql: '"project_stats"."tokens" + $1', params: [10] });
    expect(rendered(sums!.values.costUsd)).toEqual({ sql: '"project_stats"."cost_usd" + $1', params: [0.25] });

    // After the turns row has its stop reason, which the flag reads.
    expect(statements.indexOf(flag!)).toBeGreaterThan(statements.findIndex((s) => s.table === "turns"));
    expect(whereOf(flag!).params).toEqual([TURN]);
    const failed = rendered(flag!.values.lastTurnFailed);
    expect(failed.params).toEqual([...LIMIT_STOP_REASONS, TURN]);
    expect(failed.sql).toContain(`"t".stop_reason like 'error%'`);
  });

  it("sets the failed flag when a turn fails", async () => {
    const statements = await apply([{ type: "agent.turn_failed", threadId: THREAD, turnId: TURN, error: "boom" }]);
    const [flag] = stats(statements);
    expect(Object.keys(flag!.values).sort()).toEqual(["lastTurnFailed", "updatedAt"]);
    expect(whereOf(flag!).params).toEqual([TURN]);
  });
});

describe("OrchestrationEngine", () => {
  it("answers a send that lost the claim with conflict, and starts nothing", async () => {
    // Both sends read the thread idle; the projection of the second finds it
    // already queued and throws, rolling its transaction back.
    const rows: unknown[][] = [
      [{ id: THREAD, projectId: PROJECT, status: "idle", provider: null, credentialSource: null, worktreeState: null }],
      [{ project: { ...project, containerState: "running" } }],
      [{ id: workspace.id, credentialPolicy: "member", role: "owner", canCreateProject: null, canCreateSession: null }],
    ];
    const chain: Record<string, unknown> = {};
    for (const step of ["from", "leftJoin", "where"]) chain[step] = () => chain;
    chain.limit = () => Promise.resolve(rows.shift() ?? []);
    const db = { select: () => chain } as unknown as Database;
    const store = {
      append: async () => {
        throw new ProjectionConflict("this thread already has a turn in progress");
      },
    } as unknown as EventStore;
    const reacted: string[] = [];
    const engine = new OrchestrationEngine(db, store, { react: (command) => reacted.push(command.type) });

    const result = await engine.dispatch(
      { userId: USER, sessionId: "s", scopes: ["read", "write", "exec"] },
      { type: "thread.send", threadId: THREAD, text: "again" },
    );

    expect(result).toEqual({ ok: false, code: "conflict", message: "this thread already has a turn in progress" });
    expect(reacted).toEqual([]);
    await engine.worker.drain();
  });
});
