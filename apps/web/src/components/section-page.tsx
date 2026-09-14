import { sectionById, type SectionId } from "@/lib/sections";

/**
 * The page behind a rail icon whose feature has not been built yet.
 *
 * Every section is a real URL from the day its icon exists, so the rail never
 * points at a route that 404s and a bookmarked section survives the feature
 * landing. What each one says is the section's own `blurb`, so the page and
 * the sidebar panel beside it cannot drift apart.
 *
 * Nothing is fetched: the shell around it already knows the workspace, and
 * a page with no data of its own should arrive as fast as the URL changes.
 */
export function SectionPage({ section: id }: { section: SectionId }) {
  const section = sectionById(id);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="rounded-lg border p-6">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <section.icon className="text-muted-foreground size-4" />
          {section.title}
        </h2>
        <p className="text-muted-foreground mt-2 max-w-prose text-sm">{section.blurb}</p>
      </div>
    </div>
  );
}
