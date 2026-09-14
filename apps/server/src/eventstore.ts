import { and, asc, eq, gt, sql } from "drizzle-orm";
import { events, type Database, type Transaction } from "@ucch/db";
import { isTransient, type DomainEvent, type StoredEvent } from "@ucch/protocol";
import type { EventBus, Publication } from "./bus.js";

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
export class EventStore {
  constructor(
    private readonly db: Database,
    private readonly bus: EventBus,
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
        // Take the next sequence under the transaction's lock. The unique
        // index on (thread_id, seq) is the real guard: if two writers ever
        // race here, one transaction fails rather than silently interleaving.
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

  /** Replays a thread's durable events, for resume, fork, and replay. */
  async readThread(threadId: string, sinceSeq = -1): Promise<StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.threadId, threadId), gt(events.seq, sinceSeq)))
      .orderBy(asc(events.seq));

    return rows.map((row) => ({
      id: String(row.id),
      projectId: row.projectId,
      threadId: row.threadId,
      seq: row.seq,
      createdAt: row.createdAt.toISOString(),
      event: row.payload,
    }));
  }
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
