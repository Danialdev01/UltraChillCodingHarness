/**
 * A project's Tasks board, over the API.
 *
 * Mirrors the server's `TasksService`: cards in five columns, moved along
 * Research, Ongoing and Verification by the server's pipeline, plus the
 * board's settings -- which agent runs it, and when it starts on its own.
 */

import type {
  ProjectTask,
  TaskAutoRun,
  TaskReference,
  TaskSettings,
  TaskStage,
} from "@ucch/protocol";

import { FieldConflictError } from "./field-edit";

export type { ProjectTask, TaskAutoRun, TaskReference, TaskSettings, TaskStage };

export interface TaskInput {
  title: string;
  description?: string;
  references?: TaskReference[];
}

/** The server's message, or a fallback, as one throwable thing. */
async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

const json = { "content-type": "application/json" };

async function send<T>(url: string, method: string, body: unknown, fallback: string): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: "include",
    headers: json,
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) await fail(response, fallback);
  return (await response.json()) as T;
}

export async function listTasks(hash: string): Promise<ProjectTask[]> {
  const response = await fetch(`/api/projects/${hash}/tasks`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not load the tasks.");
  return ((await response.json()) as { tasks: ProjectTask[] }).tasks;
}

export async function createTask(hash: string, input: TaskInput): Promise<ProjectTask> {
  return (await send<{ task: ProjectTask }>(`/api/projects/${hash}/tasks`, "POST", input, "Could not add the todo.")).task;
}

/**
 * Writes the fields in `patch`. With `base` -- what those fields held when
 * the edit began -- a field somebody else changed meanwhile is refused as a
 * `FieldConflictError` carrying their version (`lib/field-edit.ts`).
 */
export async function updateTask(
  hash: string,
  id: string,
  patch: Partial<TaskInput>,
  base?: Partial<TaskInput>,
): Promise<ProjectTask> {
  const response = await fetch(`/api/projects/${hash}/tasks/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: json,
    body: JSON.stringify(base ? { ...patch, base } : patch),
  });
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { task?: ProjectTask };
    if (body.task) throw new FieldConflictError("Someone else changed this todo meanwhile; it now shows their version.", body.task);
  }
  if (!response.ok) await fail(response, "Could not save the todo.");
  return ((await response.json()) as { task: ProjectTask }).task;
}

export async function moveTask(
  hash: string,
  id: string,
  stage: TaskStage,
  position?: number,
): Promise<ProjectTask> {
  return (
    await send<{ task: ProjectTask }>(
      `/api/projects/${hash}/tasks/${id}/move`,
      "POST",
      { stage, ...(position !== undefined ? { position } : {}) },
      "Could not move the todo.",
    )
  ).task;
}

export async function answerTask(hash: string, id: string, answer: string): Promise<ProjectTask> {
  return (
    await send<{ task: ProjectTask }>(
      `/api/projects/${hash}/tasks/${id}/feedback`,
      "POST",
      { answer },
      "Could not send the answer.",
    )
  ).task;
}

export async function retryTask(hash: string, id: string): Promise<ProjectTask> {
  return (
    await send<{ task: ProjectTask }>(`/api/projects/${hash}/tasks/${id}/retry`, "POST", {}, "Could not retry the todo.")
  ).task;
}

export async function deleteTask(hash: string, id: string): Promise<void> {
  const response = await fetch(`/api/projects/${hash}/tasks/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) await fail(response, "Could not delete the todo.");
}

export async function fetchTaskSettings(hash: string): Promise<TaskSettings> {
  const response = await fetch(`/api/projects/${hash}/task-settings`, { credentials: "include" });
  if (!response.ok) await fail(response, "Could not load the task settings.");
  return ((await response.json()) as { settings: TaskSettings }).settings;
}

export async function saveTaskSettings(
  hash: string,
  settings: Pick<TaskSettings, "provider" | "model"> & {
    autoRun: Pick<TaskAutoRun, "enabled" | "days" | "time" | "timezone">;
  },
): Promise<TaskSettings> {
  return (
    await send<{ settings: TaskSettings }>(
      `/api/projects/${hash}/task-settings`,
      "PUT",
      settings,
      "Could not save the task settings.",
    )
  ).settings;
}

/**
 * Whether a chat thread is one the Tasks pipeline opened -- titled
 * `Task: …` or `Verify: …` by the server -- rather than a conversation.
 */
export function isTaskThreadTitle(title: string | null | undefined): boolean {
  return !!title && (title.startsWith("Task: ") || title.startsWith("Verify: "));
}

/**
 * Where a pipeline thread can be watched: the project's address, which
 * redirects to the session that thread is -- the board knows a thread by
 * its id, the address by its hash.
 */
export function taskThreadHref(ws: string, hash: string, threadId: string): string {
  return `/${ws}/p/${hash}?thread=${threadId}`;
}
