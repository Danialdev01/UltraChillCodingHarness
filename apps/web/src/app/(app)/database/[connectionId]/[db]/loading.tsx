import { DatabaseViewSkeleton } from "@/components/page-skeletons";

/** Inside the layout's shell, so only the view is drawn: the column is already there. */
export default function Loading() {
  return <DatabaseViewSkeleton />;
}
