import { Suspense } from "react";

import { NotesWorkspace } from "@/components/notes/notes-workspace";
import { NotesSkeleton } from "@/components/page-skeletons";
import { ProjectSeed } from "@/lib/queries/project";
import { requireProject } from "@/lib/workspace-route";

/**
 * A project's notes, at /{ws}/p/{project_hash}/documentation and …/documentation/{id}.
 *
 * The workspace is rendered by this layout rather than by the two pages
 * under it, so moving from one page of notes to another keeps it mounted:
 * the tree, its scroll and the open folders stay put, and only the editor
 * changes -- the workspace reads which page is open from the URL. As pages
 * the two routes had remounted it, refetching the whole tree for every
 * click on a row.
 *
 * The layout itself awaits nothing. A `loading.tsx` wraps a segment's
 * *children*, not the segment's layout, so a lookup awaited here would hold
 * the previous page on screen until it returned; done in a child under its
 * own Suspense, the skeleton paints the instant the URL changes instead.
 */
export default function NotesLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceHash: string; projectHash: string }>;
  children: React.ReactNode;
}) {
  return (
    <>
      {/* The pages render nothing; this is where a 404 from the id check
          in `[noteId]/page.tsx` surfaces. */}
      {children}
      <Suspense fallback={<NotesSkeleton />}>
        <Workspace params={params} />
      </Suspense>
    </>
  );
}

/**
 * The project is looked up once here, the way the project page does it, so
 * an unknown or someone else's hash 404s before any note is asked for.
 */
async function Workspace({ params }: { params: Promise<{ workspaceHash: string; projectHash: string }> }) {
  const { workspaceHash, projectHash } = await params;
  const project = await requireProject(workspaceHash, projectHash, "project");
  return (
    <>
      <ProjectSeed data={project} />
      <NotesWorkspace project={project} />
    </>
  );
}
