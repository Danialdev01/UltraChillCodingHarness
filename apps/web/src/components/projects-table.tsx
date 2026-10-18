"use client";

import * as React from "react";
import { ArrowUpDownIcon, FolderGitIcon } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  compactNumber,
  describeContainerState,
  formatUsd,
  relativeTime,
  shortRepo,
} from "@/lib/stats-format";
import type { Project } from "@/lib/session";
import { TransitionLink } from "@/lib/view-transitions";
import { useProjectHref } from "@/lib/workspace-context";

/** The columns, and how each one sorts. */
const COLUMNS = [
  { key: "name", label: "Project", align: "left" },
  { key: "stack", label: "Stack", align: "left" },
  { key: "containerState", label: "Container", align: "left" },
  { key: "threadCount", label: "Threads", align: "right" },
  { key: "tokens", label: "Tokens", align: "right" },
  { key: "lastActiveAt", label: "Last active", align: "right" },
] as const;

type SortKey = (typeof COLUMNS)[number]["key"];

/**
 * Every project in the workspace, as a table.
 *
 * Sorting is client-side and the rows arrive whole, which is the right trade
 * at this size: a workspace holds tens of projects, not thousands, and a
 * round-trip per column click would be slower than the sort it triggers.
 *
 * Timestamps are stamped against one instant captured on mount rather than
 * `Date.now()` per cell, so a long list cannot show two rows a second apart
 * that were written at the same moment.
 */
export function ProjectsTable({ projects }: { projects: readonly Project[] }) {
  const hrefOf = useProjectHref();
  const [sort, setSort] = React.useState<{ key: SortKey; desc: boolean }>({
    key: "lastActiveAt",
    desc: true,
  });

  // Set once, after hydration: rendering "3m ago" on the server and again in
  // the browser a second later is a hydration mismatch, and the server's
  // clock is not the reader's anyway.
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => setNow(Date.now()), [projects]);

  const rows = React.useMemo(() => {
    const value = (p: Project) => {
      switch (sort.key) {
        case "threadCount":
          return p.threadCount ?? 0;
        case "tokens":
          return p.tokens ?? 0;
        case "lastActiveAt":
          return Date.parse(p.lastActiveAt ?? "") || 0;
        default:
          return (p[sort.key] ?? "").toString().toLowerCase();
      }
    };
    return [...projects].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -order : order;
    });
  }, [projects, sort]);

  if (projects.length === 0) {
    return (
      <div className="rounded-lg border p-6">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <FolderGitIcon className="text-muted-foreground size-4" />
          Projects
        </h2>
        <p className="text-muted-foreground mt-2 text-sm">
          No projects in this workspace yet. Clone a repository to start one.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {COLUMNS.map((column) => (
              <TableHead
                key={column.key}
                className={column.align === "right" ? "text-right" : undefined}
                aria-sort={
                  sort.key === column.key ? (sort.desc ? "descending" : "ascending") : "none"
                }
              >
                <button
                  type="button"
                  onClick={() =>
                    setSort((current) =>
                      current.key === column.key
                        ? { key: column.key, desc: !current.desc }
                        : // A new column starts in the order that column is
                          // usually read: newest and busiest first, names A-Z.
                          { key: column.key, desc: column.align === "right" },
                    )
                  }
                  className={`hover:text-foreground flex items-center gap-1 ${
                    column.align === "right" ? "ml-auto" : ""
                  } ${sort.key === column.key ? "text-foreground" : ""}`}
                >
                  {column.label}
                  <ArrowUpDownIcon className="text-muted-foreground size-3" />
                </button>
              </TableHead>
            ))}
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((project) => {
            const state = describeContainerState(project.containerState);
            return (
              <TableRow key={project.id}>
                <TableCell className="max-w-72">
                  {/* The whole name is the link, and the repo under it is
                      context rather than a second target to aim at. */}
                  <TransitionLink
                    href={hrefOf(project.hash)}
                    className="hover:text-ucch-active block truncate font-medium"
                  >
                    {project.name}
                  </TransitionLink>
                  <span className="text-muted-foreground block truncate text-xs">
                    {shortRepo(project.repoUrl)}
                    {project.defaultBranch ? ` · ${project.defaultBranch}` : ""}
                  </span>
                </TableCell>

                <TableCell className="text-muted-foreground">{project.stack}</TableCell>

                <TableCell>
                  <span className="flex items-center gap-2">
                    <StateDot tone={state.tone} />
                    <span className="text-muted-foreground">{state.label}</span>
                    {project.running && (
                      // A turn in flight is the one thing on this row worth
                      // interrupting a scan for, so it is the only chromatic
                      // mark in the column.
                      <span className="bg-ucch-active-bg text-ucch-active rounded px-1.5 py-0.5 text-xs">
                        agent running
                      </span>
                    )}
                  </span>
                </TableCell>

                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {project.threadCount ?? 0}
                </TableCell>

                {/* Shortened like the Dashboard's total, with the exact
                    count and the bill it produced on hover: what the
                    project has cost is the question behind the column. */}
                <TableCell
                  className="text-muted-foreground text-right tabular-nums"
                  title={`${(project.tokens ?? 0).toLocaleString("en-US")} tokens · ${formatUsd(
                    project.costUsd ?? 0,
                  )}`}
                >
                  {project.tokens ? (
                    <>
                      {compactNumber(project.tokens)}
                      <span className="text-muted-foreground block text-xs">{formatUsd(project.costUsd ?? 0)}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>

                <TableCell
                  className="text-muted-foreground text-right whitespace-nowrap tabular-nums"
                  title={project.lastActiveAt ?? undefined}
                >
                  {now === null ? "—" : relativeTime(project.lastActiveAt, now)}
                </TableCell>

                <TableCell className="text-right">
                  <TransitionLink
                    href={hrefOf(project.hash)}
                    className="text-ucch-active text-xs whitespace-nowrap underline underline-offset-2"
                  >
                    Open
                  </TransitionLink>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** The state light. Colour carries the tone; the word beside it carries the meaning. */
function StateDot({ tone }: { tone: ReturnType<typeof describeContainerState>["tone"] }) {
  const color =
    tone === "live"
      ? "bg-ucch-active"
      : tone === "failed"
        ? "bg-destructive"
        : tone === "busy"
          ? "bg-ucch-active/50"
          : "bg-muted-foreground/40";
  return <span className={`size-2 shrink-0 rounded-full ${color}`} aria-hidden />;
}
