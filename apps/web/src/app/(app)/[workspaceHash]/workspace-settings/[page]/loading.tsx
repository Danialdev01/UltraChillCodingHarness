import { SettingsSkeleton } from "@/components/page-skeletons";

/** Its own boundary, so moving between Workspace Settings pages paints at once. */
export default function Loading() {
  return <SettingsSkeleton />;
}
