"use client"

import * as React from "react"
import { CheckIcon, ListFilterIcon } from "lucide-react"

import { HarnessIcon } from "@/components/harness-icon"
import { ProjectStackIcon } from "@/components/project-stack-icon"
import { StatusBadge } from "@/components/session-sidebar/session-card"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Segmented } from "@/components/ui/segmented"
import { Switch } from "@/components/ui/switch"
import { HARNESSES } from "@/lib/harnesses"
import {
  filtersActive,
  type FilterAction,
  type FilterHarness,
  type FilterStatus,
  type SidebarFilters,
  type SidebarProject,
} from "@/lib/session-sidebar"
import { cn } from "@/lib/utils"

const HARNESS_OPTIONS: { id: FilterHarness; name: string }[] = [
  ...Object.values(HARNESSES).map((h) => ({ id: h.id as FilterHarness, name: h.name })),
  { id: "unknown", name: "Not started" },
]

const STATUS_OPTIONS: FilterStatus[] = ["running", "waiting_input", "settled", "error", "idle"]

/**
 * What the list keeps: harness, status, project, who started it, and
 * whether archived sessions show. A dot on the button while anything is
 * narrowed, and Clear to undo it all at once.
 */
export function FilterPopover({
  filters,
  dispatch,
  projects,
  sessionWorkspace,
}: {
  filters: SidebarFilters
  dispatch: React.Dispatch<FilterAction>
  projects: readonly SidebarProject[]
  sessionWorkspace: boolean
}) {
  const active = filtersActive(filters)
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative"
            aria-label={active ? "Filter sessions (filters on)" : "Filter sessions"}
          />
        }
      >
        <ListFilterIcon />
        {active && <span className="bg-primary absolute top-1 right-1 size-1.5 rounded-full" aria-hidden />}
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-64 flex-col gap-3 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Filter</span>
          <Button variant="ghost" size="xs" disabled={!active} onClick={() => dispatch({ type: "clear" })}>
            Clear
          </Button>
        </div>

        <Group label="Harness">
          {HARNESS_OPTIONS.map((h) => (
            <Option
              key={h.id}
              checked={filters.harnesses.includes(h.id)}
              onToggle={() => dispatch({ type: "toggleHarness", harness: h.id })}
            >
              <HarnessIcon harness={h.id === "unknown" ? null : h.id} size={14} />
              {h.name}
            </Option>
          ))}
        </Group>

        <Group label="Status">
          {STATUS_OPTIONS.map((status) => (
            <Option
              key={status}
              checked={filters.statuses.includes(status)}
              onToggle={() => dispatch({ type: "toggleStatus", status })}
            >
              {status === "idle" ? <span className="text-muted-foreground">Idle</span> : <StatusBadge status={status} />}
            </Option>
          ))}
        </Group>

        {!sessionWorkspace && projects.length > 0 && (
          <Group label="Project">
            <div className="flex max-h-40 flex-col overflow-y-auto">
              {projects.map((p) => (
                <Option
                  key={p.id}
                  checked={filters.projects.includes(p.id)}
                  onToggle={() => dispatch({ type: "toggleProject", projectId: p.id })}
                >
                  <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5" aria-hidden>
                    <ProjectStackIcon stack={p.stack} />
                  </span>
                  <span className="truncate">{p.name}</span>
                </Option>
              ))}
            </div>
          </Group>
        )}

        <Group label="Created by">
          <Segmented
            options={[
              { value: "anyone", label: "Anyone" },
              { value: "me", label: "Me" },
            ]}
            value={filters.createdBy}
            onChange={(value) => dispatch({ type: "createdBy", value })}
            size="sm"
            aria-label="Created by"
            className="w-full [&>button]:flex-1"
          />
        </Group>

        <label className="flex items-center justify-between gap-2 text-sm">
          Show archived
          <Switch
            checked={filters.showArchived}
            onCheckedChange={(value) => dispatch({ type: "showArchived", value })}
          />
        </label>
      </PopoverContent>
    </Popover>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-0.5">
      <span className="text-muted-foreground pb-0.5 text-2xs font-medium">{label}</span>
      {children}
    </div>
  )
}

function Option({
  checked,
  onToggle,
  children,
}: {
  checked: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className={cn(
        "hover:bg-accent focus-visible:ring-ring flex h-7 items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none focus-visible:ring-2",
      )}
    >
      <span
        className={cn(
          "grid size-3.5 shrink-0 place-items-center rounded-sm border",
          checked && "bg-primary border-primary text-primary-foreground",
        )}
        aria-hidden
      >
        {checked && <CheckIcon className="size-3" />}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">{children}</span>
    </button>
  )
}
