import { notFound } from "next/navigation";
import { Suspense } from "react";

import { DatabaseShell } from "@/components/database/database-shell";
import { DatabaseSkeleton } from "@/components/page-skeletons";
import { getDatabaseConnection } from "@/lib/session";

/** The same shape the routes accept for `:db`, so a bad URL 404s here rather than 400s later. */
const DB_NAME = /^[^`"\x00-\x1f/\\]{1,64}$/;

/**
 * One database on one connection, at /database/{connectionId}/{db} and
 * /database/{connectionId}/{db}/{table}.
 *
 * The shell -- the tables column and the shared table list -- is rendered
 * by this layout rather than by the pages under it, so moving from table to
 * table keeps it mounted: the column, its filter and its scroll stay put,
 * and only the view changes. Like the notes layout, this one awaits
 * nothing itself; the lookup happens in a child under its own Suspense so
 * the skeleton paints the instant the URL changes.
 */
export default function DatabaseLayout({
  params,
  children,
}: {
  params: Promise<{ connectionId: string; db: string }>;
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<DatabaseSkeleton />}>
      <Shell params={params}>{children}</Shell>
    </Suspense>
  );
}

async function Shell({
  params,
  children,
}: {
  params: Promise<{ connectionId: string; db: string }>;
  children: React.ReactNode;
}) {
  const raw = await params;
  const db = decodeURIComponent(raw.db);
  if (!DB_NAME.test(db)) notFound();
  const connection = await getDatabaseConnection(decodeURIComponent(raw.connectionId));
  if (!connection) notFound();
  return (
    <DatabaseShell connection={connection} db={db}>
      {children}
    </DatabaseShell>
  );
}
