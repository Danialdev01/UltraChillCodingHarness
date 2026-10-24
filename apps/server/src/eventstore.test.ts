import { describe, expect, it } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "@ucch/db";
import type { DomainEvent } from "@ucch/protocol";
import { EventBus, type Publication } from "./bus.js";
import { EventStore } from "./eventstore.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";

const dialect = new PgDialect();

/**
 * A database double that records what an append's transaction issues, in
 * order, instead of issuing it. As in `engine.test.ts`: there is no Postgres
 * in the test environment, and the order of the statements is the point.
 */
function recorder(maxSeq: number | null = 4) {
  const log: string[] = [];
  let transactions = 0;

  const tx = {
    execute: async (query: SQL) => {
      const { sql, params } = dialect.sqlToQuery(query);
      log.push(`execute ${sql} ${JSON.stringify(params)}`);
      return [];
    },
    select: () => ({
      from: () => ({
        where: async () => {
          log.push("select max(seq)");
          return [{ max: maxSeq }];
        },
      }),
    }),
    insert: () => ({
      values: (rows: Array<{ projectId: string; threadId: string | null; seq: number; payload: DomainEvent }>) => ({
        returning: async () => {
          log.push(`insert ${rows.map((row) => row.seq).join(",")}`);
          return rows.map((row, i) => ({ ...row, id: i + 1, createdAt: new Date(0) }));
        },
      }),
    }),
  };

  const db = {
    transaction: async <T>(run: (t: typeof tx) => Promise<T>) => {
      transactions++;
      return run(tx);
    },
  } as unknown as Database;

  return { db, log, transactions: () => transactions };
}

const fileChanged: DomainEvent = { type: "file.changed", projectId: PROJECT, path: "a.txt", change: "modified" };
const delta: DomainEvent = { type: "agent.text_delta", threadId: THREAD, turnId: "55555555-5555-5555-5555-555555555555", text: "hi" };

describe("EventStore.append", () => {
  it("locks the project's stream, in its own statement, before reading the next seq", async () => {
    const { db, log } = recorder();
    const stored = await new EventStore(db, new EventBus()).append({ projectId: PROJECT, threadId: null }, [
      fileChanged,
      fileChanged,
    ]);
    expect(log).toEqual([
      `execute select pg_advisory_xact_lock(hashtextextended($1, 0)) ["project:${PROJECT}"]`,
      "select max(seq)",
      "insert 5,6",
    ]);
    expect(stored.map((event) => event.seq)).toEqual([5, 6]);
  });

  it("locks a thread's stream by the thread", async () => {
    const { db, log } = recorder(null);
    await new EventStore(db, new EventBus()).append({ projectId: PROJECT, threadId: THREAD }, [fileChanged]);
    expect(log).toEqual([
      `execute select pg_advisory_xact_lock(hashtextextended($1, 0)) ["thread:${THREAD}"]`,
      "select max(seq)",
      "insert 0",
    ]);
  });

  it("runs the projection inside the lock, before the insert", async () => {
    const { db, log } = recorder();
    await new EventStore(db, new EventBus()).append({ projectId: PROJECT, threadId: null }, [fileChanged], async () => {
      log.push("projection");
    });
    expect(log.map((line) => line.split(" ")[0])).toEqual(["execute", "select", "projection", "insert"]);
  });

  it("leaves a transient-only batch out of the database, lock and all", async () => {
    const { db, log, transactions } = recorder();
    const bus = new EventBus();
    const published: Publication[] = [];
    bus.subscribe({ name: "thread", threadId: THREAD }, (publication) => published.push(publication));
    await new EventStore(db, bus).append({ projectId: PROJECT, threadId: THREAD }, [delta]);
    expect(log).toEqual([]);
    expect(transactions()).toBe(0);
    expect(published).toEqual([{ seq: null, projectId: PROJECT, threadId: THREAD, event: delta }]);
  });
});
