import { TableView } from "@/components/database/table-view";

/** One table: its rows, its columns and indexes, and what can be done to it. */
export default async function TablePage({ params }: { params: Promise<{ table: string }> }) {
  const { table } = await params;
  return <TableView table={decodeURIComponent(table)} />;
}
