import { notFound } from "next/navigation";

import { requireWorkspace } from "@/lib/workspace-route";

/**
 * An old project page, `/{projectHash}/{page}`, from before projects lived
 * under their workspace: sent on to `/{ws}/p/{projectHash}/{page}`. Under a
 * real workspace's hash there is no such page, and it 404s.
 */
export default async function LegacyProjectPage({
  params,
}: {
  params: Promise<{ workspaceHash: string; legacy: string[] }>;
}) {
  const { workspaceHash, legacy } = await params;
  await requireWorkspace(workspaceHash, `/${legacy.join("/")}`);
  notFound();
}
