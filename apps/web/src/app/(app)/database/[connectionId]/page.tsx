import { notFound } from "next/navigation";

import { ConnectionHome } from "@/components/database/connection-home";
import { getDatabaseConnection } from "@/lib/session";

/** A connection: the server, and every database on it. */
export default async function ConnectionPage({ params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const connection = await getDatabaseConnection(decodeURIComponent(connectionId));
  if (!connection) notFound();
  return <ConnectionHome connection={connection} />;
}
