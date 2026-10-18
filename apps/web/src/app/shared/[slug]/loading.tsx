import { PublicNotesSkeleton } from "@/components/page-skeletons";

/**
 * The site's root only redirects to its notes, so it paints the notes while
 * the redirect is on its way. Below the layout, so the header is already up.
 */
export default function Loading() {
  return <PublicNotesSkeleton />;
}
