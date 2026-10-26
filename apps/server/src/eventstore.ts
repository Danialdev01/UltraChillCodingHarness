import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { events, type Database, type Transaction } from "@ucch/db";
import { isTransient, type DomainEvent, type StoredEvent } from "@ucch/protocol";
import type { EventBus, Publication } from "./bus.js";

/** A logged event with its payload left as JSON text. */
export interface RawStoredEvent {
  seq: number;
  projectId: string;
  createdAt: string;
  payload: string;
}

export interface AppendTarget {
  projectId: string;
  threadId: string | null;
}

/**
 * Appends events and publishes them, in that order, inside one transaction.
 *
 * The ordering matters: subscribers must never observe an event that a later
 * crash could roll back, so publication happens only after the transaction
 * commits. The read model is updated in the same transaction by the caller's
 * projection function, which is what guarantees it cannot durably disagree
 * with the log.
 */
export interface EventStoreOptions {
  /** Events `threadHistory` keeps in memory, across all threads. */
  historyCacheEvents?: number;
}

export class EventStore {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
    private readonly options: EventStoreOptions = {},
  ) {}

  /**
   * @param project the events all belong to one project
   * @param batch   appended atomically -- all or nothing
   * @param project a projection applied in the same transaction
   */
  async append(
    target: AppendTarget,
    batch: readonly DomainEvent[],
    projection?: (tx: Transaction) => Promise<void>,
  ): Promise<StoredEvent[]> {
    if (batch.length === 0) return [];

    const durable = batch.filter((e) => !isTransient(e.type));
    const stored: StoredEvent[] = [];

    if (durable.length > 0) {
      await this.db.transaction(async (tx) => {
        // One writer per stream at a time, until this transaction ends.
        // Project-scoped events are appended from many places outside the
        // engine (reactors, routes, the file watcher), and without the lock
        // two of them could read the same max(seq). The unique indexes on
        // (thread_id, seq) and (project_id, seq) stay as the backstop.
        await lockStream(tx, target);
        const next = await nextSeq(tx, target);

        // The projection runs first because `events.project_id` and
        // `events.thread_id` are foreign keys: a `project.created` event
        // cannot be inserted before the row it refers to exists. Both
        // statements share one transaction, so the ordering inside it is
        // invisible to any reader -- atomicity is what callers rely on, not
        // the internal sequence.
        if (projection) await projection(tx);

        const rows = durable.map((event, i) => ({
          projectId: target.projectId,
          threadId: target.threadId,
          seq: next + i,
          type: event.type,
          payload: event,
        }));

        const inserted = await tx.insert(events).values(rows).returning();

        for (const row of inserted) {
          stored.push({
            id: String(row.id),
            projectId: row.projectId,
            threadId: row.threadId,
            seq: row.seq,
            createdAt: row.createdAt.toISOString(),
            event: row.payload,
          });
        }
      });
    } else if (projection) {
      await this.db.transaction(async (tx) => projection(tx));
    }

    // Committed. Now it is safe to tell subscribers.
    //
    // Keyed by position rather than by the stored event: `stored[i].event` is
    // the payload Postgres handed back, a different object from the one that
    // went in, so an identity lookup against `batch` never matches and every
    // publication would go out with a null sequence. `durable` holds the
    // original objects and lines up with `stored` one for one.
    const bySeq = new Map<DomainEvent, number>();
    durable.forEach((event, i) => {
      const row = stored[i];
      if (row) bySeq.set(event, row.seq);
    });
    for (const event of batch) {
      const publication: Publication = {
        seq: bySeq.get(event) ?? null,
        projectId: target.projectId,
        threadId: target.threadId,
        event,
      };
      this.bus.publish(publication);
    }

    return stored;
  }

  /**
   * Replays a thread's durable events, for resume, fork, and replay.
   *
   * With `limit`, only the newest that many after `sinceSeq`, still oldest
   * first: a client opening a long thread keeps a bounded window of it
   * anyway, and sending the rest is frames it throws away.
   */
  async readThread(
    threadId: string,
    sinceSeq = -1,
    options: { limit?: number } = {},
  ): Promise<StoredEvent[]> {
    const where = and(eq(events.threadId, threadId), gt(events.seq, sinceSeq));
    const rows =
      options.limit === undefined
        ? await this.db.select().from(events).where(where).orderBy(asc(events.seq))
        : (
            await this.db.select().from(events).where(where).orderBy(desc(events.seq)).limit(options.limit)
          ).reverse();

    return rows.map(toStored);
  }

  /**
   * `readThread` for a replay, newest `limit` events in order: each payload
   * as Postgres prints it, so it goes into a frame as it is instead of
   * being parsed into objects here only to be serialized again.
   */
  async readThreadRaw(threadId: string, sinceSeq: number, limit: number): Promise<RawStoredEvent[]> {
    const rows = await this.db
      .select({
        seq: events.seq,
        projectId: events.projectId,
        createdAt: events.createdAt,
        payload: sql<string>`${events.payload}::text`,
      })
      .from(events)
      .where(and(eq(events.threadId, threadId), gt(events.seq, sinceSeq)))
      .orderBy(desc(events.seq))
      .limit(limit);
    return rows.reverse().map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  /**
   * A thread's whole durable history, for rebuilding an agent's context.
   *
   * The log is append-only, so a thread read once is kept and only what was
   * appended since is fetched on the next turn -- rather than every turn of
   * a long conversation re-reading all of it. Bounded by events, not
   * threads: a thousand-turn thread weighs what a hundred short ones do.
   * The least recently used go first, and a thread longer than half the
   * bound is read whole every time rather than pushing everyone else out.
   */
  async threadHistory(threadId: string): Promise<readonly StoredEvent[]> {
    const run = async () => {
      const cached = this.#history.get(threadId);
      const since = cached?.at(-1)?.seq ?? -1;
      const fresh = await this.readThread(threadId, since);
      const all = cached ? (fresh.length ? [...cached, ...fresh] : cached) : fresh;
      this.#forget(threadId);
      const cap = this.options.historyCacheEvents ?? HISTORY_CACHE_EVENTS;
      if (all.length <= cap / 2) {
        // Re-inserted, so iteration order is least-recently-used first.
        this.#history.set(threadId, all);
        this.#historyEvents += all.length;
        while (this.#historyEvents > cap) this.#forget(this.#history.keys().next().value!);
      }
      return all;
    };
    // One read per thread at a time, so two turns' reads cannot both extend
    // the same cached array.
    const previous = this.#historyReads.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.#historyReads.set(threadId, next);
    try {
      return await next;
    } finally {
      if (this.#historyReads.get(threadId) === next) this.#historyReads.delete(threadId);
    }
  }

  /** Events `threadHistory` holds in memory now, for `/metrics`. */
  get cachedHistoryEvents(): number {
    return this.#historyEvents;
  }

  #forget(threadId: string): void {
    const kept = this.#history.get(threadId);
    if (!kept) return;
    this.#history.delete(threadId);
    this.#historyEvents -= kept.length;
  }

  #history = new Map<string, readonly StoredEvent[]>();
  #historyEvents = 0;
  #historyReads = new Map<string, Promise<readonly StoredEvent[]>>();
}

/** Events `threadHistory` keeps in memory by default; `HISTORY_CACHE_EVENTS`. */
const HISTORY_CACHE_EVENTS = 20_000;

function toStored(row: typeof events.$inferSelect): StoredEvent {
  return {
    id: String(row.id),
    projectId: row.projectId,
    threadId: row.threadId,
    seq: row.seq,
    createdAt: row.createdAt.toISOString(),
    event: row.payload,
  };
}

/**
 * Takes the stream's advisory lock, held until the transaction ends.
 *
 * Its own statement on purpose: under READ COMMITTED each statement reads
 * its own snapshot, so a `max(seq)` in the same statement as the lock could
 * see the stream as it was before the lock was granted. `nextSeq`, issued
 * after this returns, sees every append that held the lock before.
 */
async function lockStream(tx: Transaction, target: AppendTarget): Promise<void> {
  const key = target.threadId ? `thread:${target.threadId}` : `project:${target.projectId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function nextSeq(tx: Transaction, target: AppendTarget): Promise<number> {
  const scope = target.threadId
    ? eq(events.threadId, target.threadId)
    : and(eq(events.projectId, target.projectId), sql`${events.threadId} is null`);

  const [row] = await tx
    .select({ max: sql<number | null>`max(${events.seq})` })
    .from(events)
    .where(scope);

  return (row?.max ?? -1) + 1;
}
