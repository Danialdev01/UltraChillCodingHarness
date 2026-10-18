import type { Command } from "@ucch/protocol";

import { UcchClient } from "@/lib/client";

type ProjectCreate = Extract<Command, { type: "project.create" }>;

/** What a finished `project.create` hands back to whoever asked. */
export interface CreatedProject {
  projectId: string;
  hash: string;
  /** Why the development database could not be made, when one was asked for. */
  databaseError?: string;
}

/**
 * Creates a project and resolves once its code is on disk.
 *
 * Shared by the New Project dialog and the sidebar's New Session button: both
 * open the project the moment this resolves, and a redirect at
 * `project.created` would arrive on an empty file tree and read as a broken
 * project for as long as the clone or `git init` took.
 *
 * One socket for one command, opened here and closed before returning:
 * commands go over the WebSocket, and nothing calling this has a reason to
 * hold one open the rest of the time.
 */
export async function createProject(
  command: Omit<ProjectCreate, "type">,
  onStage?: (stage: "creating" | "cloning") => void,
): Promise<CreatedProject> {
  const client = new UcchClient();
  try {
    onStage?.("creating");
    await client.connect();
    await client.whenReady();

    const created = await client.dispatch({ type: "project.create", ...command });
    const event = created[0]?.event;
    if (event?.type !== "project.created") throw new Error("the project was not created");

    // Watching the project's own stream, so the wait ends when the clone
    // reactor says it has finished rather than after a guessed delay.
    onStage?.("cloning");
    await client.subscribe({ name: "project", projectId: event.projectId });
    await waitForClone(client, event.projectId);

    const cloned = client.events.find(
      (e) => e.event.type === "project.cloned" && e.event.projectId === event.projectId,
    )?.event;
    return {
      projectId: event.projectId,
      hash: event.hash,
      ...(cloned?.type === "project.cloned" && cloned.databaseError
        ? { databaseError: cloned.databaseError }
        : {}),
    };
  } finally {
    client.close();
  }
}

/**
 * Resolves when the clone reactor has finished with this project.
 *
 * A cap rather than an indefinite wait: a very large repository should not
 * hold the dialog open for ever, and the project exists either way -- so the
 * timeout opens it anyway rather than reporting a failure that did not
 * happen.
 */
function waitForClone(client: UcchClient, projectId: string, timeoutMs = 180_000): Promise<void> {
  const cloned = () =>
    client.events.some(
      ({ event }) => event.type === "project.cloned" && event.projectId === projectId,
    );
  if (cloned()) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    const unsubscribe = client.subscribeToChanges(() => {
      if (!cloned()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** What a session is called until its first message names it. */
export const NEW_SESSION_NAME = "New session";

/**
 * A session's title from the first message sent in it: the first line,
 * cut at a word boundary to fit a sidebar card.
 */
export function sessionTitleFrom(message: string, max = 60): string | null {
  const line = message
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Renames a project -- for a session, its title. */
export async function renameProject(hash: string, name: string): Promise<void> {
  const response = await fetch(`/api/projects/${hash}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not rename it.");
  }
}
