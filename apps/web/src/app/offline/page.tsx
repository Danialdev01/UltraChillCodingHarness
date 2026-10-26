import type { Metadata } from "next";

import { LogoMark } from "@/components/logo-mark";
import { OfflineRecent, RetryButton } from "@/components/offline-recent";

export const metadata: Metadata = { title: "Offline · UCCH" };

/**
 * What the service worker shows for a page it cannot fetch and has no copy
 * of (`app/sw.ts`). Static, so the worker can precache it at install and
 * serve it with no server at all: nothing here may depend on the request.
 * The recent projects come from the browser's own persisted query cache.
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <LogoMark className="size-10 text-foreground" />
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">You&apos;re offline</h1>
          <p className="text-sm text-muted-foreground">
            This page needs the server, and it can&apos;t be reached right now.
          </p>
        </div>
        <RetryButton />
        <OfflineRecent />
      </div>
    </div>
  );
}
