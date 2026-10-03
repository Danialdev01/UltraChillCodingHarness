import { and, asc, eq, sql } from "drizzle-orm";
import { timelineTasks, type Database, type TimelineTask } from "@ucch/db";
import type { TimelineColour } from "@ucch/protocol";

/** A task as the API carries it: dates as `YYYY-MM-DD`, instants as ISO strings. */
export interface TimelineTaskRecord {
  id: string;
  title: string;
  startsOn: string;
  endsOn: string;
  progress: number;
  colour: TimelineColour;
  position: number;
  dependsOnId: string | null;
  createdAt: string;
  updatedAt: string;
}

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
  /** Saved by somebody else since `ifUpdatedAt`; `task` is what they saved. */
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
    ifUpdatedAt?: string,
  ): Promise<TimelineWriteOutcome> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(timelineTasks)
        .where(eq(timelineTasks.projectId, projectId));
      const current = rows.find((t) => t.id === taskId);
      if (!current) return null;
      if (ifUpdatedAt && current.updatedAt.getTime() !== new Date(ifUpdatedAt).getTime()) {
        return { conflict: toRecord(current) };
      }

      const startsOn = patch.startsOn ?? current.startsOn;
      const endsOn = patch.endsOn ?? current.endsOn;
      if (endsOn < startsOn) return { error: "end before start" };

      const dependsOnId = patch.dependsOnId === undefined ? current.dependsOnId : patch.dependsOnId;
      if (dependsOnId !== null) {
        if (dependsOnId === taskId || !rows.some((t) => t.id === dependsOnId)) {
          return { error: "unknown dependency" };
        }
        if (wouldCycle(rows, taskId, dependsOnId)) return { error: "dependency cycle" };
      }

      const [row] = await tx
        .update(timelineTasks)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          startsOn,
          endsOn,
          ...(patch.progress !== undefined && { progress: patch.progress }),
          ...(patch.colour !== undefined && { colour: patch.colour }),
          dependsOnId,
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
