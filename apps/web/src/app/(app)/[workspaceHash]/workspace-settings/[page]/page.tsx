import { notFound } from "next/navigation";

import { EmptyState } from "@/components/layout/empty-state";
import { PageContainer } from "@/components/layout/page-container";
import { WorkspaceSettingsPage } from "@/components/workspace-settings-page";
import { isWorkspaceSettingsPageId } from "@/lib/sections";
import { getSession, listProjects } from "@/lib/session";
import { requireWorkspace } from "@/lib/workspace-route";

/** One page of Workspace Settings, at /{ws}/workspace-settings/{page}. */
export default async function Page({ params }: { params: Promise<{ workspaceHash: string; page: string }> }) {
  const { workspaceHash, page } = await params;
  if (!isWorkspaceSettingsPageId(page)) notFound();

  const [active, session] = await Promise.all([requireWorkspace(workspaceHash), getSession()]);
  // Only the Harness page signs in from a terminal, which needs a project to publish on.
  const projects = active && page === "harness" ? await listProjects(active.id) : [];

  return (
    <PageContainer width="prose">
        {active ? (
          <WorkspaceSettingsPage
            page={page}
            workspace={active}
            currentUserId={session?.userId ?? ""}
            projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          />
        ) : (
          <EmptyState framed title="There is no workspace to configure yet." />
        )}
    </PageContainer>
  );
}
