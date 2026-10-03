import { DatabaseIcon, PanelLeftIcon } from "lucide-react";

export function DatabaseLanding() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-4">
      <div className="rounded-lg border p-6">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <DatabaseIcon className="text-muted-foreground size-4" />
          Connections
        </h2>
        <p className="text-muted-foreground mt-2 max-w-prose text-sm">
          Pick a database from a connection in the <PanelLeftIcon className="inline size-3.5 align-text-bottom" />{" "}
          Connections column to browse its tables, edit rows, run SQL, import and export data, and manage users.
          The <span className="font-medium">+</span> beside the heading adds a MySQL or PostgreSQL server.
        </p>
      </div>
    </div>
  );
}
