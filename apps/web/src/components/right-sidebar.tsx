"use client"

import { XIcon } from "lucide-react"

import { ChatDock } from "@/components/chat-dock"
import { Button } from "@/components/ui/button"
import { FilesTree, useFilesPanel } from "@/components/files-panel"
import { SearchPanel } from "@/components/search-panel"
import { cn } from "@/lib/utils"

/** How long the column takes to come in or go out, and the class that says so. */
const SLIDE = "duration-200 ease-out motion-reduce:transition-none"

/**
 * The column to the right of the page: the file tree, or the search results.
 *
 * Below the header rather than beside it, because the header spans the app and a
 * column starting above it would cut the breadcrumb short.
 *
 * It slides rather than appearing, and the two halves of that are why it is
 * built as two elements. The outer one animates its *width*, which is what makes
 * the page beside it widen and narrow smoothly instead of snapping -- the column
 * is a flex sibling of the content, not an overlay, so its width is the
 * content's width too. The inner one is a fixed 18rem and slides by its own
 * width, so the panel travels in from the edge rather than being squashed flat
 * and stretched back out.
 *
 * Mounted whether it is open or not, because an element that is not there cannot
 * animate away. Nothing is paid for that: the tree is fetched by the provider
 * against the project rather than by the panel, and the search runs only when
 * there is something typed in it. `inert` keeps a shut panel's buttons and
 * scroll container out of reach of the keyboard.
 *
 * It is available in every view, the terminal included. A shell with the tree
 * beside it is just a narrower shell, and being unable to look at a file without
 * first leaving the terminal was the wrong trade.
 */
export function RightSidebar() {
  const { project, sidebar, mode, closeChatSidebar } = useFilesPanel()
  const shown = Boolean(project) && sidebar !== null
  // Wider for the conversation than for a tree: a thread of prose and code
  // at eighteen rem is a column of wrapped fragments.
  const width = sidebar === "chat" ? "w-[28rem]" : "w-72"

  return (
    <aside
      data-slot="right-sidebar"
      data-state={shown ? "open" : "closed"}
      data-panel={sidebar ?? "none"}
      aria-hidden={!shown}
      inert={!shown}
      // min-h-0 so the panel's own scroll container bounds itself against this
      // column rather than growing it.
      className={cn(
        "hidden min-h-0 shrink-0 overflow-hidden transition-[width] md:block",
        SLIDE,
        shown ? width : "w-0",
      )}
    >
      <div
        className={cn(
          "bg-sidebar text-sidebar-foreground flex h-full min-h-0 flex-col overflow-hidden border-l transition-transform",
          SLIDE,
          width,
          shown ? "translate-x-0" : "translate-x-full",
        )}
      >
        {/* The shut column keeps whichever panel it had, so closing it does not
            animate a change of contents on the way out. */}
        {sidebar === "chat" ? (
          // Only while the page is not already showing the chat: the dock
          // here and the one in the workspace share one element, and the
          // workspace's takes over the moment the view switches.
          mode !== "chat" && (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
                <span className="font-medium">Chat</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-6 shrink-0"
                  onClick={closeChatSidebar}
                >
                  <XIcon className="size-4" />
                  <span className="sr-only">Close chat</span>
                </Button>
              </div>
              <ChatDock className="flex min-h-0 flex-1 flex-col" />
            </>
          )
        ) : sidebar === "search" ? (
          <SearchPanel />
        ) : (
          <FilesTree />
        )}
      </div>
    </aside>
  )
}
