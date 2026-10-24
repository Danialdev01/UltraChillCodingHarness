import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import { ShellSkeleton } from "@/components/page-skeletons";

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
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
