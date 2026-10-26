"use client";

import * as React from "react";
import { get, keys } from "idb-keyval";

import { Button } from "@/components/ui/button";
import type { Bootstrap } from "@/lib/session";
import { projectHref } from "@/lib/sections";

/** Tries the page that failed again: the offline page is served at that address. */
export function RetryButton() {
  return <Button onClick={() => window.location.reload()}>Try again</Button>;
}

interface Recent {
  workspace: string;
  projects: { name: string; href: string }[];
}

interface PersistedClient {
  timestamp?: number;
  clientState?: { queries?: { queryKey?: unknown[]; state?: { data?: unknown; dataUpdatedAt?: number } }[] };
}

/**
 * The newest bootstrap in the persisted query cache (`lib/query-client.tsx`):
 * the workspace that was open last and its projects, most recently active
 * first. Null when nothing was persisted, or storage cannot be read.
 */
export async function readRecent(limit = 8): Promise<Recent | null> {
  let newest: { at: number; data: Bootstrap } | null = null;
  for (const key of await keys()) {
    if (!String(key).startsWith("ucch-cache:")) continue;
    const raw = await get<string>(key);
    if (typeof raw !== "string") continue;
    let client: PersistedClient;
    try {
      client = JSON.parse(raw) as PersistedClient;
    } catch {
      continue;
    }
    for (const query of client.clientState?.queries ?? []) {
      if (query.queryKey?.[0] !== "bootstrap") continue;
      const at = query.state?.dataUpdatedAt ?? 0;
      const data = query.state?.data as Bootstrap | undefined;
      if (data && Array.isArray(data.projects) && (!newest || at > newest.at)) newest = { at, data };
    }
  }
  if (!newest) return null;
  const { workspaces, activeWorkspaceId, projects } = newest.data;
  const workspace = workspaces?.find((w) => w.id === activeWorkspaceId);
  if (!workspace) return null;
  return {
    workspace: workspace.name,
    projects: projects.slice(0, limit).map((p) => ({
      name: p.name,
      href: projectHref(workspace.hash, workspace.kind, p.hash),
    })),
  };
}

/**
 * The projects this browser saw last, as plain links: following one is a
 * full load, which the service worker answers from its copy of that page if
 * it has one, or with this page again if it does not. Read-only -- nothing
 * here can change anything until the server is back.
 */
export function OfflineRecent() {
  const [recent, setRecent] = React.useState<Recent | null>(null);

  React.useEffect(() => {
    let alive = true;
    readRecent()
      .then((value) => alive && setRecent(value))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!recent || recent.projects.length === 0) return null;
  return (
    <nav aria-label="Recent projects" className="w-full rounded-lg border text-left">
      <h2 className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
        Recent in {recent.workspace}
      </h2>
      <ul className="py-1">
        {recent.projects.map((project) => (
          <li key={project.href}>
            <a href={project.href} className="block truncate px-3 py-1.5 text-sm hover:bg-muted">
              {project.name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
