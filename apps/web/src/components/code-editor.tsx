"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { FileIcon, Loader2Icon, SaveIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useFilesPanel } from "@/components/files-panel"
import { FilePreview } from "@/components/file-preview"
import { basename } from "@/lib/files-api"
import { cn } from "@/lib/utils"
import { isPreviewable, previewKindFor } from "@ucch/protocol"

/**
 * CodeMirror and the vim layer are a third of the project page's JavaScript,
 * and the chat view never touches them -- so they are fetched when a file is
 * first opened rather than shipped with the page. There is nothing to render
 * on the server either: the editor builds itself into a DOM node.
 */
const VimEditor = dynamic(
  () => import("@/components/vim-editor").then((m) => m.VimEditor),
  {
    ssr: false,
    loading: () => (
      <div className="text-muted-foreground min-h-0 flex-1 p-4 font-mono text-xs">Loading…</div>
    ),
  },
)

/**
 * The file view: a tab per open file, and the active one's contents.
 *
 * The text comes from the project's workspace on disk and goes back to it:
 * `:w`, ctrl-S and the Save button all write through the server, which is
 * confined to that project's directory. A tab is marked modified while the
 * buffer differs from what was last read or written.
 */
export function CodeEditor() {
  const {
    project,
    tabs,
    activeTab,
    selectTab,
    closeTab,
    buffers,
    setBuffer,
    saved,
    save,
    saving,
    loadingFiles,
    fileErrors,
    reveal,
    openCodeChat,
  } = useFilesPanel()
  const strip = React.useRef<HTMLDivElement>(null)

  // Once the strip overflows, the tab you just switched to may be off the end
  // of it. `nearest` on both axes so it slides sideways only as far as it has
  // to, and never scrolls the page vertically to do it.
  React.useEffect(() => {
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
    })
  }, [activeTab, tabs.length])

  if (tabs.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Choose a file from the tree to open it.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The tab strip scrolls rather than wrapping: a second row would shift
          the contents below it every time a file is opened. */}
      {/* Scrolls sideways rather than shrinking the tabs or wrapping onto a
          second row, which would shift the editor down every time a file is
          opened. The scrollbar is hidden because it would eat a third of a
          40px strip; the active tab scrolls itself into view instead. */}
      <div
        ref={strip}
        role="tablist"
        className="no-scrollbar flex h-10 shrink-0 items-center gap-px overflow-x-auto border-b"
        onWheel={(e) => {
          // A plain mouse only has a vertical wheel, and there is nothing to
          // scroll vertically here -- so turn it sideways.
          const el = e.currentTarget
          if (el.scrollWidth <= el.clientWidth) return
          if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
          el.scrollLeft += e.deltaY
        }}
      >
        {tabs.map((path) => (
          <div
            key={path}
            className={cn(
              "group/tab flex h-full shrink-0 items-center gap-2 border-r pr-1 pl-3 text-sm",
              path === activeTab
                ? "border-b-ucch-active bg-background text-ucch-active border-b-2"
                : "text-muted-foreground hover:bg-muted/50",
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={path === activeTab}
              onClick={() => selectTab(path)}
              className="max-w-48 truncate outline-hidden"
              title={path}
            >
              {basename(path)}
            </button>
            {buffers[path] !== undefined && buffers[path] !== saved[path] && (
              <span
                className="bg-ucch-active size-1.5 shrink-0 rounded-full"
                title="Modified"
                aria-label="Modified"
              />
            )}
            <button
              type="button"
              onClick={() => closeTab(path)}
              // Always present for the active tab so its width does not jump
              // as the pointer crosses it.
              className={cn(
                "hover:bg-muted rounded-sm p-0.5 opacity-0 group-hover/tab:opacity-100",
                path === activeTab && "opacity-100",
              )}
            >
              <XIcon className="size-3.5" />
              <span className="sr-only">Close {basename(path)}</span>
            </button>
          </div>
        ))}
      </div>

      {activeTab && (
        <>
          <div className="text-muted-foreground flex h-8 shrink-0 items-center gap-1.5 border-b px-4 text-xs">
            <FileIcon className="size-3.5" />
            <span className="truncate">{activeTab}</span>
            {fileErrors[activeTab] && (
              <span role="alert" className="text-destructive truncate">
                {fileErrors[activeTab]}
              </span>
            )}
            {/* Nothing to save on a preview: the file is shown, not
                edited, and a permanently disabled Save button would only
                read as something being broken. */}
            {isPreviewable(activeTab) ? (
              <span className="ml-auto shrink-0 text-xs">
                {previewKindFor(activeTab) === "pdf" ? "PDF" : "Image"} preview
              </span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-6 px-2 text-xs"
                disabled={
                  buffers[activeTab] === undefined ||
                  buffers[activeTab] === saved[activeTab] ||
                  saving.has(activeTab)
                }
                onClick={() => void save(activeTab)}
                title="Save to the workspace (ctrl-S, or :w)"
              >
                {saving.has(activeTab) ? (
                  <Loader2Icon className="animate-spin" />
                ) : (
                  <SaveIcon />
                )}
                Save
              </Button>
            )}
          </div>

          {isPreviewable(activeTab) ? (
            project && <FilePreview hash={project.hash} path={activeTab} />
          ) : loadingFiles.has(activeTab) && buffers[activeTab] === undefined ? (
            <div className="text-muted-foreground min-h-0 flex-1 p-4 text-xs">Reading…</div>
          ) : buffers[activeTab] === undefined ? (
            // No buffer and not loading: the read failed, and the message is
            // already in the bar above.
            <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-8 text-sm">
              {fileErrors[activeTab] ?? "This file could not be opened."}
            </div>
          ) : (
            <VimEditor
              key={activeTab}
              path={activeTab}
              initialText={buffers[activeTab]!}
              text={buffers[activeTab]!}
              onChange={(text) => setBuffer(activeTab, text)}
              onSave={() => void save(activeTab)}
              onChat={(from, to, command) => openCodeChat(activeTab, from, to, command)}
              // Only when it is this file's: the request outlives the click, and
              // a line number from another file means nothing here.
              reveal={reveal?.path === activeTab ? reveal : null}
            />
          )}
        </>
      )}    </div>
  )
}
