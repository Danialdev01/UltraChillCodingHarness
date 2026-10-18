/**
 * The documentation page's diagrams, over the API.
 *
 * A diagram is a Mermaid file in the project's repository, so reading and
 * saving one are the ordinary file calls; only generating one is its own
 * route, since it runs the agent over the codebase.
 */

import { saveFile } from "./files-api";

/** Where each diagram lives in the project's checkout. Mirrors the server's `DIAGRAM_FILES`. */
export const DIAGRAM_FILES = {
  database: ".ucch/diagrams/database.mmd",
  architecture: ".ucch/diagrams/architecture.mmd",
  "system-flow": ".ucch/diagrams/system-flow.mmd",
  "user-flow": ".ucch/diagrams/user-flow.mmd",
} as const;

export type BuiltDiagramKind = keyof typeof DIAGRAM_FILES;

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(body.error ?? fallback);
}

/**
 * The diagram's source and the version naming it, or null when the file has
 * not been written yet.
 */
export async function fetchDiagram(
  hash: string,
  kind: BuiltDiagramKind,
): Promise<{ source: string; version: string | null } | null> {
  const response = await fetch(
    `/api/projects/${hash}/file?path=${encodeURIComponent(DIAGRAM_FILES[kind])}`,
    { credentials: "include" },
  );
  if (response.status === 404) return null;
  if (!response.ok) await fail(response, "Could not open the diagram.");
  const body = (await response.json()) as { content: string; version?: string };
  return { source: body.content, version: body.version ?? null };
}

/**
 * Saves over `ifVersion` only: throws `FileConflictError` when another tab,
 * the agent or a pull wrote it since. Resolves with the new version.
 */
export async function saveDiagram(
  hash: string,
  kind: BuiltDiagramKind,
  source: string,
  ifVersion: string | null,
): Promise<string | null> {
  return saveFile(hash, DIAGRAM_FILES[kind], source, ifVersion);
}

export type DiagramJob =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; path: string; source: string; model: string }
  | { state: "failed"; error: string }

/** How the diagram's generation is going, or how the last one went. */
export async function diagramJob(hash: string, kind: BuiltDiagramKind): Promise<DiagramJob> {
  const response = await fetch(`/api/projects/${hash}/diagrams/${kind}/generate`, {
    credentials: "include",
  })
  if (!response.ok) await fail(response, "Could not check on the diagram.")
  return (await response.json()) as DiagramJob
}

const POLL_MS = 2_000

/**
 * Waits for a running generation to finish, and gives back the new source.
 * Throws with the server's reason when it failed, and quietly stops (with an
 * AbortError) when `signal` fires -- the page went away.
 */
export async function awaitDiagram(
  hash: string,
  kind: BuiltDiagramKind,
  signal: AbortSignal,
): Promise<{ path: string; source: string; model: string }> {
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, POLL_MS)
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        reject(new DOMException("aborted", "AbortError"))
      }, { once: true })
    })
    const job = await diagramJob(hash, kind)
    if (job.state === "done") return job
    if (job.state === "failed") throw new Error(job.error)
    if (job.state === "idle") throw new Error("The generation was lost, perhaps to a server restart. Try again.")
  }
}

/**
 * Redraws the diagram from the codebase with the account's default model.
 *
 * Starts a job on the server and waits for it: the agent takes a minute or
 * more on a real repository, longer than a request may stay open. The server
 * saves the result; this gives back the new source.
 */
export async function generateDiagram(
  hash: string,
  kind: BuiltDiagramKind,
  signal: AbortSignal,
): Promise<{ path: string; source: string; model: string }> {
  const response = await fetch(`/api/projects/${hash}/diagrams/${kind}/generate`, {
    method: "POST",
    credentials: "include",
  })
  if (!response.ok) await fail(response, "Could not generate the diagram.")
  return awaitDiagram(hash, kind, signal)
}
