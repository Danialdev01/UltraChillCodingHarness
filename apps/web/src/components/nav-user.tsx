"use client"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { ChevronsUpDownIcon, LogOutIcon, UserRoundCogIcon } from "lucide-react"

import { forgetWarm } from "@/lib/boot-cookie"
import { clearUserCache } from "@/lib/query-client"
import { SETTINGS } from "@/lib/sections"
import { RAIL_OVERLAP_PX } from "@/lib/sidebar-metrics"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"

export function NavUser({
  user,
  compact = false,
}: {
  user: {
    name: string
    email: string
    /** Absent when no picture is set; the initials stand in for it. */
    avatar?: string
  }
  /**
   * Renders the avatar alone, for the icon rail where nothing else fits.
   * An explicit prop rather than descendant selectors that hide the text --
   * hidden-but-present markup still gets read out by screen readers.
   */
  compact?: boolean
}) {
  const { isMobile } = useSidebar()
  const router = useTransitionRouter()

  async function onLogout() {
    // The session cookie is HttpOnly, so it can only be cleared by the server.
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
    await clearUserCache()
    // The next person to sign in here boots from the start.
    forgetWarm()
    router.replace("/login")
    router.refresh()
  }
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size={compact ? "default" : "lg"}
                aria-label={compact ? user.name : undefined}
                className={
                  compact
                    ? "aria-expanded:bg-muted size-8 justify-center p-0"
                    : "aria-expanded:bg-muted"
                }
              />
            }
          >
            <Avatar className={compact ? "size-7" : undefined}>
              <AvatarImage src={user.avatar} alt={user.name} />
              <AvatarFallback>{initials(user.name)}</AvatarFallback>
            </Avatar>
            {!compact && (
              <>
                <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs">{user.email}</span>
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4" />
              </>
            )}
          </DropdownMenuTrigger>
          {/* Expanded, the menu is overshot left so it clamps flush to the
              sidebar's edge and widened to match it -- the same treatment as
              the workspace switcher at the other end. Collapsed, the sidebar
              is only as wide as the rail, so it opens to the side instead. */}
          <DropdownMenuContent
            className={
              compact
                ? "min-w-56 rounded-lg"
                : "w-(--ucch-sidebar-width) min-w-56 rounded-lg"
            }
            side={isMobile ? "bottom" : compact ? "right" : "top"}
            align={compact ? "end" : "start"}
            alignOffset={compact ? 0 : -RAIL_OVERLAP_PX}
            collisionPadding={0}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel className="p-0 font-normal">
                <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                  <Avatar>
                    <AvatarImage src={user.avatar} alt={user.name} />
                    <AvatarFallback>{initials(user.name)}</AvatarFallback>
                  </Avatar>
                  <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user.name}</span>
                    <span className="truncate text-xs">{user.email}</span>
                  </div>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {/* A link rather than a click handler: account settings have an
                  address, so they should be openable in a new tab and readable
                  in the status bar like any other. */}
              <DropdownMenuItem render={<TransitionLink href={SETTINGS.entry} />}>
                <UserRoundCogIcon />
                Account Setting
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

/** "Danial Irfan" -> "DI"; falls back to the first character. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}
