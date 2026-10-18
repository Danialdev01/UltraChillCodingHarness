import { ProjectManageSkeleton } from "@/components/project-manage";

/**
 * The page only redirects to the manage page's activity tab, so it paints
 * where it is going while the redirect is on its way.
 */
export default function Loading() {
  return <ProjectManageSkeleton />;
}
