"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"
import { BotIcon, GitBranchIcon } from "lucide-react"

import { GitProviderSettings } from "@/components/git-provider-settings"
import { ProviderSettings } from "@/components/provider-settings"
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"

export type ProviderType = "ai" | "git"

/**
 * Settings -> Providers: what answers a turn (AI Provider), and where code
 * comes from (Git Provider). The open tab is in the URL's `?type=`, written
 * with `replaceState` so switching does not fetch the page again.
 */
export function ProvidersPage({
  projects,
  initialType,
}: {
  projects: { id: string; name: string }[]
  initialType: ProviderType
}) {
  const [type, setType] = React.useState<ProviderType>(initialType)
  // A link to the other tab, followed while this page is already open.
  const linked: ProviderType = useSearchParams().get("type") === "git" ? "git" : "ai"
  React.useEffect(() => setType(linked), [linked])

  const change = (value: unknown) => {
    const next: ProviderType = value === "git" ? "git" : "ai"
    setType(next)
    const url = new URL(window.location.href)
    if (next === "ai") url.searchParams.delete("type")
    else url.searchParams.set("type", next)
    window.history.replaceState(window.history.state, "", url)
  }

  return (
    <Tabs value={type} onValueChange={change} className="gap-6">
      <TabsList aria-label="Provider type">
        <TabsTab value="ai">
          <BotIcon className="size-4" aria-hidden />
          AI Provider
        </TabsTab>
        <TabsTab value="git">
          <GitBranchIcon className="size-4" aria-hidden />
          Git Provider
        </TabsTab>
        <TabsIndicator />
      </TabsList>
      <TabsPanel value="ai">
        <ProviderSettings projects={projects} />
      </TabsPanel>
      <TabsPanel value="git">
        <GitProviderSettings />
      </TabsPanel>
    </Tabs>
  )
}
