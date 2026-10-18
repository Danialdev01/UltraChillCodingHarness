import { NotesSkeleton } from "@/components/page-skeletons";

/**
 * The page only redirects to the documentation's keys view, so it paints
 * where it is going while the redirect is on its way.
 */
export default function Loading() {
  return <NotesSkeleton />;
}
