"use client"

import { PanelRightCloseIcon, PanelRightOpenIcon, SearchIcon } from "lucide-react"

import { useFilesPanel } from "@/components/files-panel"
import { cn } from "@/lib/utils"

/**
 * The two sidebar buttons, at the right end of the view switcher.
 *
 * They are not part of the switcher and are deliberately not merged into it:
 * the switcher chooses which half of the project you are looking at, and these
 * say what is in the column beside it. Reading the files while the chat is open
 * is the common case -- asking about a file you can see -- and until these
 * existed the tree could only be reached from the project's menu in the sidebar,
 * three clicks away from the page it belongs to.
 *
 * Both stay put in every view, the terminal included: a shell with the tree
 * beside it is just a narrower shell, and having to leave the terminal before
 * you could look at a file was the wrong trade.
 *
 * A panel glyph rather than a folder tree for the first one: the switcher's own
 * Files tab is a folder tree, and two of those side by side read as one control
 * drawn twice. It points at where the column comes in from, and flips once the
 * tree is in it.
 *
 * Hidden on small screens along with the column they control, so neither is ever
 * a button that does nothing.
 */
export function SidebarToggles() {
  const { project, filesOpen, searchOpen, openFiles, closeFiles, openSearch, closeSearch } =
    useFilesPanel()

  const TreeIcon = filesOpen ? PanelRightCloseIcon : PanelRightOpenIcon

  return (
    <>
      {/* A rule rather than a gap: it is what says the buttons beside it are
          states and not two more places to go. */}
      <span aria-hidden className="bg-border mx-0.5 hidden h-4 w-px md:block" />

      <SidebarButton
        label={filesOpen ? "Hide the file explorer" : "Show the file explorer"}
        pressed={filesOpen}
        disabled={!project}
        onToggle={() => (filesOpen ? closeFiles() : project && openFiles(project))}
        icon={TreeIcon}
      />

      <SidebarButton
        label={searchOpen ? "Hide the file search" : "Search all files"}
        pressed={searchOpen}
        disabled={!project}
        onToggle={() => (searchOpen ? closeSearch() : openSearch())}
        icon={SearchIcon}
      />
    </>
  )
}

function SidebarButton({
  label,
  pressed,
  disabled,
  onToggle,
  icon: Icon,
}: {
  label: string
  pressed: boolean
  disabled: boolean
  onToggle: () => void
  icon: typeof SearchIcon
}) {
  return (
    <button
      type="button"
      // The state, not the action, so it is `aria-pressed` rather than a
      // changed label: the icon stays put and lights up.
      aria-pressed={pressed}
      disabled={disabled}
      title={label}
      onClick={onToggle}
      className={cn(
        "hidden size-7 items-center justify-center rounded-md transition-colors md:flex",
        "text-muted-foreground hover:text-foreground disabled:opacity-50",
        "aria-pressed:bg-background aria-pressed:text-ucch-active aria-pressed:shadow-sm",
      )}
    >
      <Icon className="size-3.5" />
      <span className="sr-only">{label}</span>
    </button>
  )
}
