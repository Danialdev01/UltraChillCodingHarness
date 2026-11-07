import { AccountSettings } from "@/components/account-settings"
import { ActivityFeed } from "@/components/activity/activity-feed"
import { ApiKeySettings } from "@/components/api-key-settings"
import { ProviderSettings } from "@/components/provider-settings"
import { SyntaxSettings } from "@/components/syntax-settings"
import { ThemePresets } from "@/components/theme-presets"
import { ThemeSettings } from "@/components/theme-settings"
import { UsageSettings, type WorkspaceStorage, type WorkspaceUsage } from "@/components/usage-settings"
import type { SettingsPageId } from "@/lib/sections"

/**
 * The body of one Settings page.
 *
 * Which page is a matter of the URL: the sidebar's Settings panel lists them
 * as rows, and the lit one is read off the address bar the same way the rail
 * reads its section -- so there is no tab state to remember, and a link to
 * `/setting/api` lands on API keys by itself.
 */
export function SettingsPage({
  page,
  usage,
  storage,
  projects,
}: {
  page: SettingsPageId
  usage: WorkspaceUsage | null
  /** Only fetched for the Usage page; null elsewhere. */
  storage: WorkspaceStorage | null
  /** The active workspace's projects: a sign-in terminal needs one to publish on. */
  projects: { id: string; name: string }[]
}) {
  switch (page) {
    case "account":
      return <AccountSettings />
    case "api":
      return <ApiKeySettings />
    case "providers":
      return <ProviderSettings projects={projects} />
    case "usage":
      return <UsageSettings usage={usage} storage={storage} />
    case "activity":
      // Framed like the project's Activity tab: the feed's toolbar is a
      // full-bleed bar, which needs an edge to sit against.
      return (
        <div className="bg-card flex max-h-[calc(100svh-10rem)] min-h-80 flex-col overflow-hidden rounded-lg border">
          <ActivityFeed source={{ kind: "account" }} />
        </div>
      )
    case "theme":
      return (
        <div className="flex flex-col gap-8">
          <ThemeSettings />
          <SyntaxSettings />
          <ThemePresets />
        </div>
      )
  }
}
