"use client"

import { usePathname } from "next/navigation"
import { ClockIcon, FileTextIcon, FolderIcon, LockIcon } from "lucide-react"

import { Prefetch } from "@/components/prefetch"
import { MAIN_CONTENT_ID, SkipLink } from "@/components/skip-link"
import { publicHref, type PublicProject } from "@/lib/public-api"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"

const TABS = [
  { id: "notes", title: "Notes", icon: FileTextIcon },
  { id: "timeline", title: "Timeline", icon: ClockIcon },
  { id: "documents", title: "Documents", icon: FolderIcon },
] as const

/** Tiptap, which every page of the notes is drawn with; split out of the notes tab. */
const READER = [() => import("@/components/public/note-reader-impl")]

/**
 * The chrome of a public site: the project's name, the three tabs, and a
 * quiet reminder that nothing here can be changed.
 *
 * Deliberately not the app's shell. There is no workspace to switch, no
 * project list, no account -- a visitor has one project and three views of
 * it, and the header says so.
 */
export function PublicShell({ project, children }: { project: PublicProject; children: React.ReactNode }) {
  const pathname = usePathname()
  return (
    <div className="bg-background text-foreground flex h-svh flex-col overflow-hidden">
      <SkipLink />
      {/* Once the first tab is idle, the other two and the page reader load behind it. */}
      <Prefetch hrefs={TABS.map((tab) => publicHref(project.slug, tab.id))} chunks={READER} />
      <header className="flex h-12 shrink-0 items-center gap-4 border-b px-4">
        <TransitionLink href={publicHref(project.slug, "notes")} className="min-w-0 truncate text-sm font-semibold">
          {project.name}
        </TransitionLink>
        <nav className="flex items-center gap-1" aria-label="Sections">
          {TABS.map((tab) => {
            const href = publicHref(project.slug, tab.id)
            const active = pathname === href || pathname.startsWith(href + "/")
            return (
              <TransitionLink
                key={tab.id}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
                  active ? "bg-ucch-active-bg text-ucch-active" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <tab.icon className="size-3.5" />
                {tab.title}
              </TransitionLink>
            )
          })}
        </nav>
        <span className="text-muted-foreground ml-auto inline-flex items-center gap-1.5 text-xs">
          <LockIcon className="size-3" /> Read-only
        </span>
      </header>
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex min-h-0 flex-1 focus-visible:outline-none">
        {children}
      </main>
    </div>
  )
}
