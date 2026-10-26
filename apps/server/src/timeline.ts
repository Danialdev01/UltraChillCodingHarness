import { and, asc, eq, sql } from "drizzle-orm";
import { timelineTasks, type Database, type TimelineTask } from "@ucch/db";
import type { TimelineColour, TimelineTaskRecord } from "@ucch/protocol";
import { staleFields } from "./field-guard.js";

export type { TimelineTaskRecord };

export interface TimelineTaskInput {
  title: string;
  startsOn: string;
  endsOn: string;
  progress?: number;
  colour?: TimelineColour;
  dependsOnId?: string | null;
}

export type TimelineTaskPatch = Partial<TimelineTaskInput>;

/** A write that did not happen, and why -- worded for the person who asked. */
export type TimelineWriteOutcome =
  | { task: TimelineTaskRecord }
  /** A field being written was changed by somebody else; `conflict` is what they saved. */
  | { conflict: TimelineTaskRecord }
  | { error: "end before start" | "unknown dependency" | "dependency cycle" }
  | null;

/**
 * A project's timeline tasks, the rows behind the Gantt chart.
 *
 * Every method takes the project id first and scopes its query by it, so a
 * task id from another project is simply not found -- the route resolves the
 * project through `findByHash` and the ownership check happens once, there.
 */
export class TimelineService {
  constructor(private readonly db: Database) {}

  /** Every task in the project, top to bottom. */
  async list(projectId: string): Promise<TimelineTaskRecord[]> {
    const rows = await this.db
      .select()
      .from(timelineTasks)
      .where(eq(timelineTasks.projectId, projectId))
      .orderBy(asc(timelineTasks.position), asc(timelineTasks.createdAt));
    return rows.map(toRecord);
  }

  /** A new task at the bottom of the chart. */
  async create(projectId: string, input: TimelineTaskInput): Promise<TimelineWriteOutcome> {
    if (input.endsOn < input.startsOn) return { error: "end before start" };
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: timelineTasks.id, dependsOnId: timelineTasks.dependsOnId })
        .from(timelineTasks)
        .where(eq(timelineTasks.projectId, projectId));
      if (input.dependsOnId && !existing.some((t) => t.id === input.dependsOnId)) {
        return { error: "unknown dependency" };
      }
      const [slot] = await tx
        .select({ next: sql<number>`coalesce(max(${timelineTasks.position}), -1) + 1` })
        .from(timelineTasks)
        .where(eq(timelineTasks.projectId, projectId));
      const [row] = await tx
        .insert(timelineTasks)
        .values({
          projectId,
          title: input.title,
          startsOn: input.startsOn,
          endsOn: input.endsOn,
          progress: input.progress ?? 0,
          colour: input.colour ?? "blue",
          dependsOnId: input.dependsOnId ?? null,
          position: Number(slot?.next ?? 0),
          updatedAt: new Date(),
        })
        .returning();
      return { task: toRecord(row!) };
    });
  }

  /**
   * Writes the fields given. The dates are checked against the merged row,
   * so moving only the start past the end is refused the same as sending
   * both the wrong way round. Null when the task is not in this project.
   */
  async update(
    projectId: string,
    taskId: string,
    patch: TimelineTaskPatch,
    guard: { ifUpdatedAt?: string; base?: TimelineTaskPatch } = {},
  ): Promise<TimelineWriteOutcome> {
    return this.db.transaction(async (tx) => {
      // The task itself locked first: the checks below and the write must
      // see the same row, or a drag landing between them would be undone.
      const [locked] = await tx
        .select()
        .from(timelineTasks)
        .where(and(eq(timelineTasks.projectId, projectId), eq(timelineTasks.id, taskId)))
        .for("update");
      if (!locked) return null;
      const { ifUpdatedAt, base } = guard;
      if (ifUpdatedAt && locked.updatedAt.getTime() !== new Date(ifUpdatedAt).getTime()) {
        return { conflict: toRecord(locked) };
      }
      if (staleFields(toRecord(locked), base).length > 0) return { conflict: toRecord(locked) };

      const startsOn = patch.startsOn ?? locked.startsOn;
      const endsOn = patch.endsOn ?? locked.endsOn;
      if (endsOn < startsOn) return { error: "end before start" };

      if (patch.dependsOnId) {
        const rows = await tx
          .select({ id: timelineTasks.id, dependsOnId: timelineTasks.dependsOnId })
          .from(timelineTasks)
          .where(eq(timelineTasks.projectId, projectId));
        if (patch.dependsOnId === taskId || !rows.some((t) => t.id === patch.dependsOnId)) {
          return { error: "unknown dependency" };
        }
        if (wouldCycle(rows, taskId, patch.dependsOnId)) return { error: "dependency cycle" };
      }

      // Only what was sent: a rename never writes back the dates it read.
      const [row] = await tx
        .update(timelineTasks)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.startsOn !== undefined && { startsOn: patch.startsOn }),
          ...(patch.endsOn !== undefined && { endsOn: patch.endsOn }),
          ...(patch.progress !== undefined && { progress: patch.progress }),
          ...(patch.colour !== undefined && { colour: patch.colour }),
          ...(patch.dependsOnId !== undefined && { dependsOnId: patch.dependsOnId }),
          updatedAt: new Date(),
        })
        .where(and(eq(timelineTasks.projectId, projectId), eq(timelineTasks.id, taskId)))
        .returning();
      return { task: toRecord(row!) };
    });
  }

  /** True when a task was removed; false when there was none to remove. */
  async remove(
    projectId: string,
    taskId: string,
    ifUpdatedAt?: string,
  ): Promise<{ title: string } | { conflict: TimelineTaskRecord } | false> {
    const conditions = [eq(timelineTasks.projectId, projectId), eq(timelineTasks.id, taskId)];
    if (ifUpdatedAt) conditions.push(eq(timelineTasks.updatedAt, new Date(ifUpdatedAt)));
    const deleted = await this.db
      .delete(timelineTasks)
      .where(and(...conditions))
      .returning({ title: timelineTasks.title });
    if (deleted[0]) return deleted[0];
    if (!ifUpdatedAt) return false;
    // Not deleted: either gone already, or changed since the tab last saw it.
    const [current] = await this.db
      .select()
      .from(timelineTasks)
      .where(and(eq(timelineTasks.projectId, projectId), eq(timelineTasks.id, taskId)))
      .limit(1);
    return current ? { conflict: toRecord(current) } : false;
  }
}

/**
 * Would pointing `taskId` at `dependsOnId` close a loop?
 *
 * Follows the chain up from the proposed dependency; if it reaches the task
 * itself the arrow would come back around. Bounded by the row count so a
 * loop already in the data, however it got there, cannot spin forever.
 */
export function wouldCycle(
  rows: readonly { id: string; dependsOnId: string | null }[],
  taskId: string,
  dependsOnId: string,
): boolean {
  const parentOf = new Map(rows.map((r) => [r.id, r.dependsOnId]));
  let cursor: string | null | undefined = dependsOnId;
  for (let hops = 0; cursor && hops <= rows.length; hops++) {
    if (cursor === taskId) return true;
    cursor = parentOf.get(cursor);
  }
  return false;
}

export function toRecord(row: TimelineTask): TimelineTaskRecord {
  return {
    id: row.id,
    title: row.title,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    progress: row.progress,
    colour: row.colour as TimelineColour,
    position: row.position,
    dependsOnId: row.dependsOnId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
