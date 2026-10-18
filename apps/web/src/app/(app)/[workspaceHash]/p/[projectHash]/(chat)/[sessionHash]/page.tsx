import { notFound } from "next/navigation";

import { ProjectWorkspace } from "@/components/project-workspace";
import { HASH } from "@/lib/sections";
import { listProjectSessions } from "@/lib/session";
import { requireProject } from "@/lib/workspace-route";

/**
 * One session of a project, at /{ws}/p/{project_hash}/{session_hash}.
 *
 * A project has any number of sessions, each its own conversation running
 * in its own git worktree on a branch of its own, so several can run at
 * once -- forked from the same branch or from different ones. The project's
 * own pages (`tasks`, `documentation`, …) are static segments beside this
 * one and are matched first; anything else that is not a hash 404s here
 * before a lookup.
 */
export default async function ProjectSessionPage({
  params,
}: {
  params: Promise<{ workspaceHash: string; projectHash: string; sessionHash: string }>;
}) {
  const { workspaceHash, projectHash, sessionHash } = await params;
  if (!HASH.test(sessionHash)) notFound();
  const [project, sessions] = await Promise.all([
    requireProject(workspaceHash, projectHash, "project"),
    listProjectSessions(projectHash),
  ]);
  const session = sessions.find((s) => s.hash === sessionHash);
  if (!session) notFound();

  // Keyed so moving between sessions starts each one's chat, terminal and
  // tree afresh rather than carrying the last session's into it.
  return <ProjectWorkspace key={session.hash} project={project} session={session} />;
}
