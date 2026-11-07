import { ComingSoon } from "@/components/layout/empty-state";
import { PageContainer, PageHeading } from "@/components/layout/page-container";
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
    <PageContainer width="wide">
      <PageHeading icon={section.icon} title={section.title} description={section.blurb} />
      <ComingSoon
        icon={section.icon}
        title={`${section.title} is on its way`}
        description="This section has a home already, so links to it keep working when it lands."
        className="min-h-64"
      />
    </PageContainer>
  );
}
