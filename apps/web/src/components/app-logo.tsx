"use client"

import { LogoMark } from "@/components/logo-mark"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { HOME } from "@/lib/sections"
import { TransitionLink } from "@/lib/view-transitions"

/**
 * The logo at the top of the icon rail, linking to the root page, where the
 * sidebar lists your workspaces.
 *
 * Styled as a rail button so it hovers and focuses like its neighbours, but
 * never lit: it is a shortcut, not a rail section.
 */
export function AppLogo() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          aria-label="Your workspaces"
          // The button's variants pad it to a 16px glyph, and pad it again
          // once collapsed; the logo wants most of the 32px square instead.
          className="size-8 p-1 group-data-[collapsible=icon]:p-1!"
          render={<TransitionLink href={HOME.href} />}
          tooltip={{ children: "Your workspaces", hidden: false }}
        >
          {/* `!` because the button sizes every svg inside it to 16px. */}
          <LogoMark className="size-[21.6px]!" />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
