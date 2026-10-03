import { ActivitySkeleton } from "@/components/activity/activity-feed";

/** Shown the instant the URL changes, until the project has been looked up. */
export default function Loading() {
  return <ActivitySkeleton />;
}
