import { SettingsSkeleton } from "@/components/page-skeletons";

/**
 * Its own boundary, not just the one above: moving from one settings page to
 * the next changes only this segment, and without a boundary here the old
 * page would stay on screen until the new one had rendered on the server.
 */
export default function Loading() {
  return <SettingsSkeleton />;
}
