"use client"

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { HOME } from "@/lib/sections"
import { TransitionLink } from "@/lib/view-transitions"

/**
 * The application's mark: a square C nested in a larger one, with a teal dot.
 *
 * Drawn on an 8x8 grid, one unit per stroke, redrawn from
 * `documentation/reference images/`. Inline rather than an imported file so
 * the navy can be `currentColor` and follow the theme's foreground -- as an
 * `<img>` it would vanish against a dark sidebar. The teal accent stays fixed.
 * `app/icon.svg` is the same drawing for the browser tab.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 8 8" aria-hidden="true" className={className}>
      <path fill="currentColor" d="M0 0H6V1H1V7H7V2H8V8H0ZM2 2H6V3.5H5V3H3V5H5V4.5H6V6H2Z" />
      <rect x="7" y="0" width="1" height="1" fill="#377876" />
    </svg>
  )
}

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
