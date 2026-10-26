/**
 * A project's timeline tasks, over the API.
 *
 * Mirrors the server's `TimelineService`: a flat list of tasks, each a bar on
 * the Gantt chart. Dates travel as `YYYY-MM-DD` and are never turned into a
 * `Date` here -- a task runs "from the 3rd to the 9th" in every timezone.
 */

import type { TimelineColour } from "@ucch/protocol";

import { FieldConflictError } from "./field-edit";

export interface TimelineTask {
  id: string;
  title: string;
  startsOn: string;
  /** Inclusive: a one-day task starts and ends on the same day. */
  endsOn: string;
  /** 0..100 */
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

/** The server's message, or a fallback, as one throwable thing. */
async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

const json = { "content-type": "application/json" };

export async function listTimelineTasks(hash: string): Promise<TimelineTask[]> {
  const response = await fetch(`/api/projects/${hash}/timeline/tasks`, {
    credentials: "include",
  });
  if (!response.ok) await fail(response, "Could not load the timeline.");
  return ((await response.json()) as { tasks: TimelineTask[] }).tasks;
}

export async function createTimelineTask(
  hash: string,
  input: TimelineTaskInput,
): Promise<TimelineTask> {
  const response = await fetch(`/api/projects/${hash}/timeline/tasks`, {
    method: "POST",
    credentials: "include",
    headers: json,
    body: JSON.stringify(input),
  });
  if (!response.ok) await fail(response, "Could not add the task.");
  return ((await response.json()) as { task: TimelineTask }).task;
}

/**
 * Writes the fields in `patch`. With `base` -- what those fields held when
 * the edit or the drag began -- a field somebody else changed meanwhile is
 * refused as a `FieldConflictError` carrying their version.
 */
export async function updateTimelineTask(
  hash: string,
  taskId: string,
  patch: TimelineTaskPatch,
  base?: TimelineTaskPatch,
): Promise<TimelineTask> {
  const response = await fetch(`/api/projects/${hash}/timeline/tasks/${taskId}`, {
    method: "PATCH",
    credentials: "include",
    headers: json,
    body: JSON.stringify(base ? { ...patch, base } : patch),
  });
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { task?: TimelineTask };
    if (body.task) throw new FieldConflictError("Someone else changed this task meanwhile; it now shows their version.", body.task);
  }
  if (!response.ok) await fail(response, "Could not save the task.");
  return ((await response.json()) as { task: TimelineTask }).task;
}

export async function deleteTimelineTask(hash: string, taskId: string): Promise<void> {
  const response = await fetch(`/api/projects/${hash}/timeline/tasks/${taskId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) await fail(response, "Could not remove the task.");
}
