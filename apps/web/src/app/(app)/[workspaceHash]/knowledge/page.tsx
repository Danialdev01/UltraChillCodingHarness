import { KnowledgeIndex } from "@/components/knowledge/knowledge-index";
import { requireWorkspace } from "@/lib/workspace-route";

/**
 * A workspace's knowledge bases, at /{ws}/knowledge: every base as a
 * card, and the button that makes a new one. The list itself is fetched on
 * the client, so the page paints as soon as the workspace is known.
 */
export default async function KnowledgePage({ params }: { params: Promise<{ workspaceHash: string }> }) {
  const { workspaceHash } = await params;
  const workspace = await requireWorkspace(workspaceHash, "/knowledge");
  return <KnowledgeIndex workspaceId={workspace.id} canWrite={workspace.permissions.includes("project.write")} />;
}
