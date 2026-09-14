import { notFound } from "next/navigation";

import { ProjectWorkspace } from "@/components/project-workspace";
import { PROJECT_HASH } from "@/lib/sections";
import { getProjectByHash } from "@/lib/session";

/**
 * A project's conversation view, at /{project_hash}.
 *
 * This is a dynamic segment at the root, so it is reached only after the
 * static routes (/login, /dashboard) fail to match. The hash format is
 * checked before any lookup, so arbitrary paths 404 rather than hitting the
 * database.
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectHash: string }>;
}) {
  const { projectHash } = await params;
  if (!PROJECT_HASH.test(projectHash)) notFound();

  // Returns null both for "does not exist" and "not yours" -- the API does
  // not distinguish them, and neither should this page.
  const project = await getProjectByHash(projectHash);
  if (!project) notFound();

  return <ProjectWorkspace project={project} />;
}
