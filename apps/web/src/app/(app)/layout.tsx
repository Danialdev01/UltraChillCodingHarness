import { Suspense } from "react";
import { cookies } from "next/headers";

import { AppShell } from "@/components/app-shell";
import { BootGate } from "@/components/boot-gate";
import { ShellSkeleton } from "@/components/page-skeletons";
import { WARM_COOKIE } from "@/lib/boot-cookie";

/**
 * Every signed-in page shares the shell, and shares it as a *layout* so that
 * a page switch keeps it: the sidebar, header and their data stay mounted
 * while only the page inside changes. See `AppShell` for what follows from
 * that.
 *
 * The shell asks the API who is signed in before it can draw the sidebar.
 * Under a Suspense boundary the outline of the shell is streamed at once and
 * the real one replaces it when that answer arrives, so a hard load or the
 * first page after signing in never shows a blank window. A client-side
 * navigation keeps the mounted layout and never sees this fallback.
 *
 * The first page of a browser session opens behind the boot screen instead,
 * while the whole app loads (see `BootGate`). It is drawn here, outside the
 * boundary, so it is in the very first bytes rather than after the shell.
 * Reading a cookie is not a lookup: nothing is awaited on the network.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const booted = (await cookies()).has(WARM_COOKIE);
  return (
    <>
      {booted ? null : <BootGate />}
      <Suspense fallback={<ShellSkeleton />}>
        <AppShell booted={booted}>{children}</AppShell>
      </Suspense>
    </>
  );
}
