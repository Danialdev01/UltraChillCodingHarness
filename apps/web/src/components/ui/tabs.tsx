"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-4", className)}
      {...props}
    />
  )
}

/**
 * The strip of tabs.
 *
 * Scrolls sideways rather than wrapping: a second row of tabs would shift
 * the panel below it, and on a phone three labels plus padding is already
 * close to the width available.
 */
function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        "no-scrollbar text-muted-foreground relative flex w-full shrink-0 items-center gap-1 overflow-x-auto border-b",
        className,
      )}
      {...props}
    />
  )
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        // The active tab is marked by the indicator below rather than by a
        // border of its own, so nothing has to be kept in sync with it.
        "focus-visible:ring-ring hover:text-foreground data-selected:text-foreground relative flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md px-3 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-inset",
        className,
      )}
      {...props}
    />
  )
}

/** The underline, which Base UI positions and animates between tabs. */
function TabsIndicator({ className, ...props }: TabsPrimitive.Indicator.Props) {
  return (
    <TabsPrimitive.Indicator
      data-slot="tabs-indicator"
      className={cn(
        "bg-ucch-active absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) transition-all duration-200",
        className,
      )}
      {...props}
    />
  )
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("flex flex-col gap-4 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTab, TabsIndicator, TabsPanel }
