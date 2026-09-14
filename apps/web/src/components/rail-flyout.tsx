"use client"

import * as React from "react"
import { PreviewCard } from "@base-ui/react/preview-card"

import { SectionPanel } from "@/components/section-panel"
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import type { Section } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { TransitionLink } from "@/lib/view-transitions"

/**
 * A rail icon, and what it opens when the sidebar is collapsed.
 *
 * Collapsed, the rail is six anonymous glyphs and everything the panel used
 * to show is behind a click. Hovering an icon now brings that panel back as a
 * flyout -- Code lists the workspace's projects, and every other section
 * shows whatever it shows expanded. The contents come from `SectionPanel`
 * itself rather than a second list built for the flyout, so the two cannot
 * drift apart as sections gain real items.
 *
 * A hover card rather than a menu, because the point is to *see* the section
 * rather than to pick from a set of commands: it opens on hover, stays open
 * while the pointer travels to it, and closes on its own. Expanded, none of
 * this applies -- the panel is already on screen -- so the item falls back to
 * the plain button and its tooltip.
 */
export function RailItem({
  section,
  isActive,
  projects,
  activeProjectHash,
  onOpenSidebar,
}: {
  section: Section
  isActive: boolean
  projects: Project[]
  activeProjectHash?: string
  /** Following an icon reopens the panel, so a click does something visible. */
  onOpenSidebar: () => void
}) {
  const { state, isMobile } = useSidebar()
  const collapsed = state === "collapsed"
  const [open, setOpen] = React.useState(false)

  // The button is identical in both branches; only what wraps it changes.
  const button = (
    <SidebarMenuButton
      isActive={isActive}
      onClick={onOpenSidebar}
      className="px-2.5 md:px-2"
      render={<TransitionLink href={section.href} />}
      // The rail is icon-width whether or not the sidebar is expanded, so the
      // label is never beside the icon and the tooltip always earns its place
      // -- `hidden: false` overrides the button's own collapsed-only rule.
      // The exception is when the flyout is in play: it names the section in
      // its own header, and a tooltip would be a second label fighting it.
      {...(collapsed && !isMobile ? {} : { tooltip: { children: section.title, hidden: false } })}
    />
  )

  // The padding is on the item rather than the button: the button's height is
  // pinned by its variants (h-8, and size-8! once collapsed), so padding
  // there would eat into the icon's hit area instead of spacing the rail out.
  const item = (children: React.ReactNode) => (
    <SidebarMenuItem className="py-[5px]">{children}</SidebarMenuItem>
  )

  // On a phone the sidebar is a sheet, not a rail: there is nothing collapsed
  // to expand, and a hover card has no hover to open it.
  if (!collapsed || isMobile) {
    return item(
      React.cloneElement(button, {}, <section.icon />, <span>{section.title}</span>),
    )
  }

  return item(
    <PreviewCard.Root open={open} onOpenChange={setOpen}>
      {/* Short to open, longer to close: the card should feel like part of
          the icon rather than something that has to be waited for, and the
          pointer needs time to cross the gap to it without it vanishing. */}
      <PreviewCard.Trigger delay={120} closeDelay={200} render={button}>
        <section.icon />
        <span>{section.title}</span>
      </PreviewCard.Trigger>

      <PreviewCard.Portal>
        <PreviewCard.Positioner
          side="right"
          align="start"
          sideOffset={8}
          // Kept off the very edge of a short window, so a long project list
          // is not clipped by the viewport.
          collisionPadding={8}
          className="z-50"
        >
          <PreviewCard.Popup
            // Exactly the width the panel has when expanded, so the flyout
            // reads as that panel arriving rather than as a different thing.
            className="bg-popover text-popover-foreground ring-foreground/10 max-h-[min(28rem,var(--available-height))] w-(--ucch-sidebar-panel-width) overflow-y-auto rounded-lg py-1 shadow-md ring-1 outline-none"
            // Any link inside is a navigation, and a card left hanging over
            // the page it just moved to would have to be dismissed by hand.
            onClick={() => setOpen(false)}
          >
            {/* The name the tooltip used to carry. Without it a collapsed
                rail's flyout would show a list with nothing saying what it
                is a list of. */}
            <p className="text-muted-foreground px-4 pt-2 pb-1 text-xs font-medium">
              {section.title}
            </p>
            <SectionPanel
              section={section}
              projects={projects}
              activeProjectHash={activeProjectHash}
              compact
              onNavigate={() => setOpen(false)}
            />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>,
  )
}
