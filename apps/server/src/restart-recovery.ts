import { and, desc, eq, inArray } from "drizzle-orm";
import { threads, turns, type Database } from "@ucch/db";
import type { DomainEvent } from "@ucch/protocol";
import { applyProjection } from "./engine.js";
import type { EventStore } from "./eventstore.js";

/** What a turn the restart cut off says, in the thread and its log. */
export const RESTART_ERROR = "The server restarted while this turn was running.";

/**
 * A turn lives in this process, so nothing that was running before a
 * restart is running now (plan2 §4.1). Each thread left `running` or
 * `cancelling` gets its open turn -- the latest, with no stop reason and no
 * error -- closed by an `agent.turn_failed`, so the log and the chat show
 * the turn that was cut off rather than one that never ends; then the
 * thread is set `idle`: the crash is the harness's, not the conversation's,
 * and left `running` the one-turn-at-a-time guard would refuse every new
 * message on it.
 */
export async function failInterruptedTurns(db: Database, store: EventStore, onError: (error: unknown) => void): Promise<{ id: string }[]> {
  const stuck = await db
    .select({ id: threads.id, projectId: threads.projectId })
    .from(threads)
    .where(inArray(threads.status, ["running", "cancelling"]));
  for (const thread of stuck) {
    const [turn] = await db
      .select({ id: turns.id, stopReason: turns.stopReason, error: turns.error })
      .from(turns)
      .where(eq(turns.threadId, thread.id))
      .orderBy(desc(turns.seq))
      .limit(1);
    if (!turn || turn.stopReason !== null || turn.error !== null) continue;
    const events: DomainEvent[] = [{ type: "agent.turn_failed", threadId: thread.id, turnId: turn.id, error: RESTART_ERROR }];
    await store
      .append({ projectId: thread.projectId, threadId: thread.id }, events, (tx) => applyProjection(tx, events, null))
      .catch(onError);
  }
  if (stuck.length === 0) return [];
  // `agent.turn_failed` leaves a thread in `error`; these go back to idle.
  return db
    .update(threads)
    .set({ status: "idle" })
    .where(and(inArray(threads.id, stuck.map((thread) => thread.id)), inArray(threads.status, ["running", "cancelling", "error"])))
    .returning({ id: threads.id });
}
