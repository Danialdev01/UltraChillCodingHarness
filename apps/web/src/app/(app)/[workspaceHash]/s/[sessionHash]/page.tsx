import { ProjectWorkspace } from "@/components/project-workspace";
import { requireProject } from "@/lib/workspace-route";

/**
 * A session in a session workspace, at /{ws}/s/{session_hash}.
 *
 * Such a session is a project row of its own -- its hash is the project's --
 * with one conversation, its files and a terminal, so the page is the
 * project view itself.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ workspaceHash: string; sessionHash: string }>;
}) {
  const { workspaceHash, sessionHash } = await params;
  const project = await requireProject(workspaceHash, sessionHash, "session");
  return <ProjectWorkspace project={project} />;
}
