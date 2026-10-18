import { redirect } from "next/navigation";

import { FirstSession } from "@/components/first-session";
import { projectHref } from "@/lib/sections";
import { listProjectSessions } from "@/lib/session";
import { isTaskThreadTitle } from "@/lib/tasks-api";
import { requireProject } from "@/lib/workspace-route";

/**
 * A project's own address, /{ws}/p/{project_hash}: where it was left off.
 *
 * Every conversation in a project is a session with an address of its own,
 * so this only redirects -- to the newest session, passing over the Tasks
 * board's threads (those are the pipeline's work, not where the person left
 * off). `?thread=` names one by id, which is how the board links to the
 * thread a task runs in. A project with no session yet gets its first one
 * here, working in the project's main checkout.
 *
 * In the `(chat)` route group with the session page, so the conversation
 * skeleton covers both the hop and the page it lands on.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceHash: string; projectHash: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceHash, projectHash }, { thread, ...rest }] = await Promise.all([params, searchParams]);
  const [project, sessions] = await Promise.all([
    requireProject(workspaceHash, projectHash, "project"),
    listProjectSessions(projectHash),
  ]);

  const asked = typeof thread === "string" ? sessions.find((s) => s.id === thread) : undefined;
  const open = asked ?? sessions.find((s) => !isTaskThreadTitle(s.title));
  if (open) {
    // The rest of the query is the session page's (`?preview=setup`).
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(rest)) {
      for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
    }
    const search = query.toString();
    redirect(`${projectHref(workspaceHash, "project", projectHash, open.hash)}${search ? `?${search}` : ""}`);
  }

  return <FirstSession project={project} />;
}
