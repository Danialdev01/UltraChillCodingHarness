import { notFound } from "next/navigation";

import { Skeleton } from "@/components/ui/skeleton";
import { PROJECT_HASH, projectPageById, type ProjectPageId } from "@/lib/sections";
import { getProjectByHash } from "@/lib/session";

/**
 * A page under a project whose feature has not been built yet: Keys, Manage.
 *
 * Each is a real URL from the day its sidebar row exists, for the same
 * reason the rail's sections are (see `SectionPage`): a row that 404s is
 * worse than one that says what will be there. The project is looked up the
 * way the project page itself does it, so an unknown or someone else's hash
 * 404s here too rather than rendering a placeholder for nothing.
 */
export async function ProjectSubPage({
  params,
  page,
}: {
  params: Promise<{ projectHash: string }>;
  page: ProjectPageId;
}) {
  const { projectHash } = await params;
  if (!PROJECT_HASH.test(projectHash)) notFound();
  const project = await getProjectByHash(projectHash);
  if (!project) notFound();

  return <ProjectPageCard page={page} projectName={project.name} />;
}

/**
 * The card itself, shared with the page's `loading.tsx`.
 *
 * Everything on it but the project's name is known before the lookup, so the
 * loading state draws the real title, icon and blurb and leaves a bar only
 * where the name will go -- the page arrives by filling in one word rather
 * than by replacing a skeleton.
 */
export function ProjectPageCard({
  page: id,
  projectName,
}: {
  page: ProjectPageId;
  projectName?: string;
}) {
  const page = projectPageById(id);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="rounded-lg border p-6">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <page.icon className="text-muted-foreground size-4" />
          {page.title}
          <span className="text-muted-foreground flex items-center gap-2 font-normal">
            · {projectName ?? <Skeleton className="h-3.5 w-28" />}
          </span>
        </h2>
        <p className="text-muted-foreground mt-2 max-w-prose text-sm">{page.blurb}</p>
      </div>
    </div>
  );
}
