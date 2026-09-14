"use client"

import * as React from "react"
import {
  BotIcon,
  ChartColumnIcon,
  KeyRoundIcon,
  PaletteIcon,
  SlidersHorizontalIcon,
  UserRoundIcon,
} from "lucide-react"

import { AccountSettings } from "@/components/account-settings"
import { ApiKeySettings } from "@/components/api-key-settings"
import { DefaultSettings } from "@/components/default-settings"
import { ProviderSettings } from "@/components/provider-settings"
import { SyntaxSettings } from "@/components/syntax-settings"
import { ThemePresets } from "@/components/theme-presets"
import { ThemeSettings } from "@/components/theme-settings"
import { UsageSettings, type WorkspaceUsage } from "@/components/usage-settings"
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"

const TABS = [
  { value: "account", label: "Account", icon: UserRoundIcon },
  { value: "api", label: "API Management", icon: KeyRoundIcon },
  { value: "providers", label: "Agent Providers", icon: BotIcon },
  { value: "default", label: "Default", icon: SlidersHorizontalIcon },
  { value: "usage", label: "Usage", icon: ChartColumnIcon },
  { value: "theme", label: "Theme", icon: PaletteIcon },
] as const

/** Where the chosen tab is remembered between visits. */
const STORAGE_KEY = "ucch:settings-tab"

/**
 * Settings, split six ways.
 *
 * The tab lives in the URL hash as well as in `localStorage`: the hash is
 * what makes a particular tab linkable and survives a reload of the page
 * itself, and storage is what brings you back to the one you were last in
 * when you arrive with no hash at all.
 *
 * Both are read after mount rather than during render -- the server has
 * neither -- so the first paint is always the first tab and nothing is
 * hydrated against a value the server could not have known.
 */
export function SettingsTabs({
  usage,
  projects,
}: {
  usage: WorkspaceUsage | null
  /** The active workspace's projects: a sign-in terminal needs one to publish on. */
  projects: { id: string; name: string }[]
}) {
  const [tab, setTab] = React.useState<string>(TABS[0].value)

  React.useEffect(() => {
    function fromHash(): string | null {
      const value = globalThis.location?.hash.replace(/^#/, "")
      return value && TABS.some((t) => t.value === value) ? value : null
    }

    const initial = fromHash()
    if (initial) {
      setTab(initial)
    } else {
      try {
        const remembered = globalThis.localStorage?.getItem(STORAGE_KEY)
        if (remembered && TABS.some((t) => t.value === remembered)) setTab(remembered)
      } catch {
        /* a preference is never worth an exception */
      }
    }

    // Arriving at #account while already on this page changes only the hash,
    // so nothing remounts and the mount-time read above never runs again --
    // without this, the profile menu's Account item would do nothing when
    // Settings was already open on another tab.
    function onHashChange() {
      const value = fromHash()
      if (value) setTab(value)
    }
    globalThis.addEventListener?.("hashchange", onHashChange)
    return () => globalThis.removeEventListener?.("hashchange", onHashChange)
  }, [])

  function choose(value: string) {
    setTab(value)
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value)
    } catch {
      /* nothing to do: the tab simply is not remembered */
    }
    // `replaceState` rather than assigning the hash: this should not add an
    // entry to the history stack for every tab the reader glances at.
    globalThis.history?.replaceState(null, "", `#${value}`)
  }

  return (
    <Tabs value={tab} onValueChange={(value) => choose(String(value))}>
      <TabsList>
        {TABS.map((entry) => (
          <TabsTab key={entry.value} value={entry.value}>
            <entry.icon className="size-3.5" />
            {entry.label}
          </TabsTab>
        ))}
        <TabsIndicator />
      </TabsList>

      <TabsPanel value="account">
        <AccountSettings />
      </TabsPanel>

      <TabsPanel value="api">
        <ApiKeySettings />
      </TabsPanel>

      <TabsPanel value="providers">
        <ProviderSettings projects={projects} />
      </TabsPanel>

      <TabsPanel value="default">
        <DefaultSettings />
      </TabsPanel>

      <TabsPanel value="usage">
        <UsageSettings usage={usage} />
      </TabsPanel>

      <TabsPanel value="theme" className="flex flex-col gap-4">
        <ThemeSettings />
        <SyntaxSettings />
        <ThemePresets />
      </TabsPanel>
    </Tabs>
  )
}
