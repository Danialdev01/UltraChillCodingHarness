import { notFound } from "next/navigation";

import { KeysWorkspace } from "@/components/keys/keys-workspace";
import { PROJECT_HASH } from "@/lib/sections";
import { getProjectByHash } from "@/lib/session";

/**
 * A project's saved keys, at /{project_hash}/keys. The project is looked up
 * the way the timeline does it, so an unknown or someone else's hash 404s
 * before any key is asked for.
 */
export default async function Page({ params }: { params: Promise<{ projectHash: string }> }) {
  const { projectHash } = await params;
  if (!PROJECT_HASH.test(projectHash)) notFound();
  const project = await getProjectByHash(projectHash);
  if (!project) notFound();
  return <KeysWorkspace project={project} />;
}
