"use client"

import * as React from "react"

import { ActivityFeed } from "@/components/activity/activity-feed"
import { GitRemoteSettings } from "@/components/git/remote-settings"
import { ProjectPreferences } from "@/components/project-preferences"
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs"
import { MANAGE_TABS, manageTabOf, type ManageTab } from "@/lib/manage-tabs"
import type { Project } from "@/lib/session"

/**
 * The tabs under the manage page's figures. The open tab is kept in the
 * URL's `?tab=` so a reload or a shared link lands on it -- written with
 * `replaceState` rather than a navigation, so switching tabs does not
 * re-render the page on the server or fill up the back button.
 */
export function ManageTabs({ project, initialTab }: { project: Project; initialTab: ManageTab }) {
  const [tab, setTab] = React.useState<ManageTab>(initialTab)

  const change = (value: unknown) => {
    const next = manageTabOf(typeof value === "string" ? value : undefined)
    setTab(next)
    const url = new URL(window.location.href)
    if (next === "git") url.searchParams.delete("tab")
    else url.searchParams.set("tab", next)
    window.history.replaceState(window.history.state, "", url)
  }

  return (
    <Tabs value={tab} onValueChange={change}>
      <TabsList>
        {MANAGE_TABS.map((t) => (
          <TabsTab key={t.id} value={t.id}>
            {t.label}
          </TabsTab>
        ))}
        <TabsIndicator />
      </TabsList>

      <TabsPanel value="git">
        <GitRemoteSettings hash={project.hash} />
      </TabsPanel>

      <TabsPanel value="activity">
        <div className="flex max-h-[70vh] min-h-80 flex-col overflow-hidden rounded-lg border">
          <ActivityFeed source={{ kind: "project", project }} />
        </div>
      </TabsPanel>

      <TabsPanel value="preferences">
        <ProjectPreferences project={project} />
      </TabsPanel>
    </Tabs>
  )
}
