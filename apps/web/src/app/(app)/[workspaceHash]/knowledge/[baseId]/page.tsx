import { notFound } from "next/navigation";

import { KnowledgeBaseView } from "@/components/knowledge/knowledge-base-view";
import { knowledgeTabOf } from "@/lib/knowledge-tabs";
import { requireWorkspace } from "@/lib/workspace-route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One knowledge base, at /{ws}/knowledge/{baseId}: its documents, its graph,
 * and a search over it, in tabs. `?tab=` picks the tab it opens on.
 */
export default async function KnowledgeBasePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceHash: string; baseId: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ workspaceHash, baseId }, { tab }] = await Promise.all([params, searchParams]);
  if (!UUID.test(baseId)) notFound();
  const workspace = await requireWorkspace(workspaceHash, `/knowledge/${baseId}`);
  return (
    <KnowledgeBaseView
      key={baseId}
      workspaceId={workspace.id}
      baseId={baseId}
      canWrite={workspace.permissions.includes("project.write")}
      initialTab={knowledgeTabOf(tab)}
    />
  );
}
