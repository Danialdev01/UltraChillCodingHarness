"use client"

import type { LucideIcon } from "lucide-react"

import { Tabs, TabsIndicator, TabsList, TabsTab } from "@/components/ui/tabs"

export interface ViewTab<Id extends string = string> {
  id: Id
  label: string
  icon: LucideIcon
}

/**
 * The strip across the top of a database or table view. Only the strip:
 * the open tab's panel is whatever the caller renders below, so a panel
 * that fetches on mount is mounted only while it is the one open.
 */
export function ViewTabs<Id extends string>({
  tabs,
  value,
  onChange,
  trailing,
}: {
  tabs: readonly ViewTab<Id>[]
  value: Id
  onChange: (id: Id) => void
  trailing?: React.ReactNode
}) {
  return (
    <Tabs value={value} onValueChange={(next) => onChange(String(next) as Id)} className="shrink-0 gap-0">
      <TabsList className="h-10 px-2">
        {tabs.map((tab) => (
          <TabsTab key={tab.id} value={tab.id} className="h-10">
            <tab.icon className="size-3.5" />
            {tab.label}
          </TabsTab>
        ))}
        <TabsIndicator />
        {trailing && <div className="ml-auto flex items-center gap-1 pl-2">{trailing}</div>}
      </TabsList>
    </Tabs>
  )
}
