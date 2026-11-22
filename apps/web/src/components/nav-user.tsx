"use client"

import { useSyncExternalStore } from "react"
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
import { useSidebar } from "@/components/ui/sidebar"
import { DownloadIcon, LogOutIcon, UserRoundCogIcon } from "lucide-react"

import { canInstall, clearPageCache, promptInstall, subscribeInstall } from "@/lib/pwa"
import { clearUserCache } from "@/lib/query-client"
import { SETTINGS } from "@/lib/sections"
import { TransitionLink } from "@/lib/view-transitions"

/**
 * The account, as an avatar at the foot of the icon rail. It opens the
 * account menu: settings, installing the app, logging out.
 *
 * In the rail rather than a full-width footer, so the panel keeps that
 * height for its list, and the account stays on screen when the panel is
 * collapsed away.
 */
export function NavUser({
  user,
}: {
  user: {
    name: string
    email: string
    /** Absent when no picture is set; the initials stand in for it. */
    avatar?: string
  }
}) {
  const { isMobile } = useSidebar()
  // Offered only while the browser says the app can be installed: never in
  // an installed window, and not in browsers without the prompt at all.
  const installable = useSyncExternalStore(subscribeInstall, canInstall, () => false)
  const label = user.email ? `${user.name} · ${user.email}` : user.name

  async function onLogout() {
    // The session cookie is HttpOnly, so it can only be cleared by the server.
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" })
    await clearUserCache()
    await clearPageCache()
    // A full load: nothing of this account's router state or cache survives.
    window.location.replace("/login")
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Account: ${label}`}
        title={label}
        className="focus-visible:ring-focus-ring mt-0.5 grid size-[30px] shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2"
      >
        <Avatar className="ring-border hover:ring-border-strong size-[30px] ring-1 transition-shadow duration-150 after:hidden">
          <AvatarImage src={user.avatar} alt="" />
          <AvatarFallback className="bg-accent-soft text-accent-strong text-[11px] font-semibold">
            {initials(user.name)}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-56 rounded-lg"
        side={isMobile ? "top" : "right"}
        align="end"
        sideOffset={8}
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
                Settings
              </DropdownMenuItem>
              {installable && (
                <DropdownMenuItem onClick={() => void promptInstall()}>
                  <DownloadIcon />
                  Install app
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Danial Irfan" -> "DI"; falls back to the first character. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}
