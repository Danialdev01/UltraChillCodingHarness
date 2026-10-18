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
 * `/setting/api` lands on API Management by itself.
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
      return <ActivityFeed source={{ kind: "account" }} />
    case "theme":
      return (
        <div className="flex flex-col gap-4">
          <ThemeSettings />
          <SyntaxSettings />
          <ThemePresets />
        </div>
      )
  }
}
