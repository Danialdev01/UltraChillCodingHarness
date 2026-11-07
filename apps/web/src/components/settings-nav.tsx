"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { SearchIcon } from "lucide-react"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { settingsPageFromPath, workspaceSettingsPageFromPath } from "@/lib/sections"
import {
  SETTINGS_GROUPS,
  settingsEntryHref,
  settingsEntryIcon,
  settingsEntryTitle,
} from "@/lib/settings-index"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * The settings nav in the sidebar panel: every settings page, account and
 * workspace alike, in a few named groups, with a search field over their
 * names and what they hold. `/` focuses the search while the nav is shown.
 */
export function SettingsNav({ onNavigate, compact = false }: { onNavigate?: () => void; compact?: boolean }) {
  const pathname = usePathname()
  const ws = useWorkspaceHash()
  const activeAccount = settingsPageFromPath(pathname)
  const activeWorkspace = workspaceSettingsPageFromPath(pathname)
  const [query, setQuery] = React.useState("")
  const input = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (compact) return
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, select, [contenteditable=true], .cm-editor, .xterm")) return
      event.preventDefault()
      input.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [compact])

  const needle = query.trim().toLowerCase()
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    entries: group.entries.filter((entry) => {
      // A workspace page needs a workspace to live under.
      if (entry.scope === "workspace" && !ws) return false
      if (!needle) return true
      return `${settingsEntryTitle(entry)} ${entry.keywords}`.toLowerCase().includes(needle)
    }),
  })).filter((group) => group.entries.length > 0)

  return (
    <>
      {!compact && (
        <div className="px-2 pt-2">
          <label className="border-input bg-background focus-within:ring-ring flex h-8 items-center gap-2 rounded-lg border px-2.5 focus-within:ring-2 dark:bg-input/30">
            <SearchIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
            <input
              ref={input}
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("")
                  input.current?.blur()
                }
              }}
              placeholder="Search settings"
              aria-label="Search settings"
            />
            <kbd className="text-muted-foreground bg-muted rounded border px-1 font-mono text-2xs">/</kbd>
          </label>
        </div>
      )}
      {groups.length === 0 && (
        <p className="text-muted-foreground px-4 py-3 text-sm">No settings match “{query.trim()}”.</p>
      )}
      {groups.map((group) => (
        <SidebarGroup key={group.label ?? "top"} className="px-0 py-1">
          {group.label && <SidebarGroupLabel className="px-4">{group.label}</SidebarGroupLabel>}
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5 px-2">
              {group.entries.map((entry) => {
                const Icon = settingsEntryIcon(entry)
                const href = settingsEntryHref(entry, ws)
                const isActive = entry.scope === "account" ? activeAccount === entry.id : activeWorkspace === entry.id
                return (
                  <SidebarMenuItem key={`${entry.scope}-${entry.id}`}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={onNavigate}
                      render={<TransitionLink href={href} />}
                    >
                      <Icon />
                      <span className="truncate">{settingsEntryTitle(entry)}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  )
}
