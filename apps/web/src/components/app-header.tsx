"use client"

import { Fragment, Suspense, useEffect, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { GlobeIcon } from "lucide-react"

import { PreviewDialog } from "@/components/preview-dialog"
import { ViewModeToggle } from "@/components/view-mode-toggle"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { projectHashFromPath, sectionForPath } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"

/**
 * The bar across the top of every page: the sidebar toggle, where you are,
 * and -- on a project -- the view switcher.
 *
 * Where you are is read off the URL rather than told by the page. The shell
 * is a layout now, rendered once and kept across navigations, so the page
 * inside it is not there to say what it is until its data has streamed in;
 * the URL is there from the first frame. A section's name comes from the
 * rail's own list, and a project's from the workspace's project list the
 * layout already holds -- so the crumb is right while the page is still a
 * skeleton, and never flips from one name to another once it lands.
 */
export function AppHeader({
  workspaceName,
  projects,
}: {
  workspaceName: string
  projects: readonly Project[]
}) {
  const pathname = usePathname()
  const projectHash = projectHashFromPath(pathname)
  const project = projectHash ? projects.find((p) => p.hash === projectHash) : undefined

  const crumbs = projectHash
    ? // A hash the list does not know is a project you have just created, or
      // one that will 404 in a moment; either way there is nothing better to
      // show than that it is a project.
      [project?.name ?? "Project"]
    : [workspaceName, sectionForPath(pathname).title]

  return (
    <header className="bg-background flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:h-16 sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
      {/* `min-w-0` so a long project name truncates instead of pushing the
          view toggles off a phone screen -- without it the chat's own
          controls become unreachable on the device that needs them most. */}
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {crumbs.map((crumb, i) => (
            // The separator is its own <li>, so it has to be a sibling of the
            // item rather than a child of it -- an <li> inside an <li> is
            // invalid HTML and the browser's fix-up trips hydration.
            <Fragment key={`${i}-${crumb}`}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{crumb}</BreadcrumbPage>
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {/* Only a project has views to switch between, or files to put beside
          them. */}
      {projectHash && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Suspense because the button reads the search params, which
              Next wants fenced off from any static parent. */}
          {project && (
            <Suspense>
              <PreviewButton project={project} />
            </Suspense>
          )}
          {/* The tree toggle lives inside this, at its right end. */}
          <ViewModeToggle />
        </div>
      )}
    </header>
  )
}

/**
 * Opens the preview dialog. Lit when a port is set, so the bar says at a
 * glance whether this project can be opened from outside.
 *
 * Also opens itself when the URL asks (`?preview=setup`): that is where the
 * share link sends someone who followed it before a port was chosen.
 */
function PreviewButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  const wantsSetup = useSearchParams().get("preview") === "setup"
  useEffect(() => {
    if (wantsSetup) setOpen(true)
  }, [wantsSetup])

  return (
    <>
      <button
        type="button"
        aria-pressed={Boolean(project.previewPort)}
        title={project.previewPort ? `Preview on port ${project.previewPort}` : "Preview"}
        onClick={() => setOpen(true)}
        className={cn(
          "flex size-7 items-center justify-center rounded-md transition-colors",
          "text-muted-foreground hover:text-foreground",
          "aria-pressed:text-ucch-active",
        )}
      >
        <GlobeIcon className="size-3.5" />
        <span className="sr-only">Preview</span>
      </button>
      <PreviewDialog project={project} open={open} onOpenChange={setOpen} />
    </>
  )
}
