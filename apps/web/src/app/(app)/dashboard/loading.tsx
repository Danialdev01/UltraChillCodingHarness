import { DashboardSkeleton } from "@/components/page-skeletons";

/** Shown the instant the URL changes, until the page's data has streamed in. */
export default function Loading() {
  return <DashboardSkeleton />;
}
