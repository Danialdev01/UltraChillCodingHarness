"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { FileIcon, Loader2Icon, RadioIcon, SaveIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useFileBuffers, useFilesPanel } from "@/components/files-panel"
import { FilePreview } from "@/components/file-preview"
import { FileTypeIcon } from "@/components/file-type-icon"
import { LeaderPicker, type PickerItem } from "@/components/leader-picker"
import { CodeLinesSkeleton } from "@/components/page-skeletons"
import type { VimEditor as VimEditorType } from "@/components/vim-editor"
import { FILE_FIELD, fileDocumentName, useCollabDocument, useCollabUser } from "@/lib/collab"
import { flattenTree } from "@/lib/file-tree"
import { basename } from "@/lib/files-api"
import { targetOf } from "@/lib/project-target"
import type { LeaderCommand } from "@/lib/leader-keymap"
import { matchLines } from "@/lib/line-search"
import { cn } from "@/lib/utils"
import { usePresenceLocation } from "@/lib/realtime"
import { isPreviewable, previewKindFor } from "@ucch/protocol/plain"

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
      <div className="min-h-0 flex-1">
        <CodeLinesSkeleton />
      </div>
    ),
  },
)

/**
 * The file view: a tab per open file, and the active one's contents.
 *
 * The text comes from the project's workspace on disk and goes back to it.
 * An open file is shared live with everyone else who has it open
 * (`LiveFile`), and the collab service writes it back as it is typed. Without
 * the service, `:w`, ctrl-S and the Save button write through the server,
 * which is confined to that project's directory, and a tab is marked
 * modified while the buffer differs from what was last read or written.
 */
export function CodeEditor() {
  const {
    project,
    tabs,
    activeTab,
    selectTab,
    closeTab,
    saved,
    save,
    saving,
    loadingFiles,
    fileErrors,
    reveal,
    revealInFile,
    openCodeChat,
    openFile,
    openSearch,
    tree,
    dirty: dirtyFiles,
    live,
  } = useFilesPanel()
  const { buffers, setBuffer } = useFileBuffers()
  // Where this person is, for everyone else's presence stack.
  const dirty = activeTab !== null && dirtyFiles.has(activeTab)
  usePresenceLocation(project?.id, activeTab ? `file:${activeTab}` : "code", dirty)
  const strip = React.useRef<HTMLDivElement>(null)

  /**
   * The leader menu that is open, if one is: `SPC s s` lists this file's
   * lines, `SPC .` the project's files, `SPC ,` the open tabs. `line` is
   * where the cursor was, so the line list opens highlighting it.
   */
  const [picker, setPicker] = React.useState<
    { kind: "lines"; path: string; line: number } | { kind: "files" } | { kind: "buffers" } | null
  >(null)

  const onLeader = React.useCallback(
    (command: LeaderCommand, line: number) => {
      if (!activeTab) return
      switch (command) {
        case "search-buffer":
          setPicker({ kind: "lines", path: activeTab, line })
          return
        case "find-file":
          setPicker({ kind: "files" })
          return
        case "switch-buffer":
          setPicker({ kind: "buffers" })
          return
        case "save":
          void save(activeTab)
          return
        case "kill-buffer":
          closeTab(activeTab)
          return
        case "next-buffer":
        case "prev-buffer": {
          // Wrapping, as Doom's next-buffer does: from the last tab, next is
          // the first.
          const index = tabs.indexOf(activeTab)
          const step = command === "next-buffer" ? 1 : -1
          selectTab(tabs[(index + step + tabs.length) % tabs.length]!)
          return
        }
        case "search-project":
          openSearch()
          return
        case "ex":
          // Handled inside the vim layer; never arrives here.
          return
      }
    },
    [activeTab, tabs, save, closeTab, selectTab, openSearch],
  )

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
      <div className="font-code flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Choose a file from the tree to open it.</p>
      </div>
    )
  }

  return (
    // JetBrains Mono, not the UI's faces: the whole editor section -- tabs,
    // path bar and buffer -- reads as one surface with the code in it.
    <div className="font-code flex min-h-0 flex-1 flex-col">
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
            {dirtyFiles.has(path) && (
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
            ) : live.has(activeTab) ? (
              <span
                className="ml-auto flex shrink-0 items-center gap-1 text-xs"
                title="Shared live with everyone who has this file open, and saved as you type"
              >
                <RadioIcon className="size-3.5" /> Live
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
            project && <FilePreview hash={targetOf(project)} path={activeTab} />
          ) : loadingFiles.has(activeTab) && buffers[activeTab] === undefined ? (
            <div className="min-h-0 flex-1">
              <CodeLinesSkeleton />
            </div>
          ) : buffers[activeTab] === undefined ? (
            // No buffer and not loading: the read failed, and the message is
            // already in the bar above.
            <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-8 text-sm">
              {fileErrors[activeTab] ?? "This file could not be opened."}
            </div>
          ) : (
            <LiveFile
              key={activeTab}
              path={activeTab}
              initialText={buffers[activeTab]!}
              text={buffers[activeTab]!}
              onChange={(text) => setBuffer(activeTab, text)}
              onSave={() => void save(activeTab)}
              onChat={(from, to, command) => openCodeChat(activeTab, from, to, command)}
              onLeader={onLeader}
              // Only when it is this file's: the request outlives the click, and
              // a line number from another file means nothing here.
              reveal={reveal?.path === activeTab ? reveal : null}
            />
          )}
        </>
      )}

      {picker?.kind === "lines" && (
        <LineSearch
          text={buffers[picker.path] ?? ""}
          line={picker.line}
          onClose={() => setPicker(null)}
          onPick={(line) => revealInFile(picker.path, line)}
        />
      )}
      {picker?.kind === "files" && (
        <LeaderPicker
          open
          onOpenChange={(open) => !open && setPicker(null)}
          title="Find file"
          placeholder="Find file in project…"
          items={fileItems(flattenTree(tree))}
          onPick={openFile}
        />
      )}
      {picker?.kind === "buffers" && (
        <LeaderPicker
          open
          onOpenChange={(open) => !open && setPicker(null)}
          title="Switch buffer"
          placeholder="Switch to an open file…"
          items={fileItems(tabs, (path) =>
            buffers[path] !== undefined && buffers[path] !== saved[path] ? "modified" : undefined,
          )}
          initialValue={activeTab ?? undefined}
          onPick={selectTab}
        />
      )}
    </div>
  )
}

/**
 * One open file, bound to its shared document: everyone with the file open
 * types into the same text and sees each other's cursors, and the collab
 * service writes it back to disk a moment after typing stops. A change on
 * disk -- the agent, a terminal -- arrives through the document too, as an
 * edit that leaves every cursor where it was.
 *
 * Until the document has synced, the file is shown as read, unchangeable,
 * so opening it never flashes a skeleton. A document the service refuses or
 * cannot be reached for is edited the old way: saved with `:w`, over the
 * version it was opened at.
 */
function LiveFile({
  path,
  ...props
}: React.ComponentProps<typeof VimEditorType>) {
  const { project, setLive } = useFilesPanel()
  const name = project ? fileDocumentName(project.id, project.sessionHash, path) : null
  const { shown, failed } = useCollabDocument(name, { fresh: true, giveUpAfterMs: 5000 })
  const user = useCollabUser()
  const isLive = shown !== null

  React.useEffect(() => {
    setLive(path, isLive)
    return () => setLive(path, false)
  }, [path, isLive, setLive])

  React.useEffect(() => {
    shown?.provider.setAwarenessField("user", user)
  }, [shown?.provider, user])

  if (!shown) return <VimEditor key="read" path={path} {...props} readOnly={!failed} />
  return (
    <VimEditor
      key={shown.generation}
      path={path}
      {...props}
      collab={{ ytext: shown.provider.document.getText(FILE_FIELD), awareness: shown.provider.awareness }}
      // Out of touch: paused rather than kept, since a copy typed into
      // offline could not be merged back into one reopened from disk.
      readOnly={!shown.connected || shown.readOnly}
    />
  )
}

/**
 * `SPC s s`: every line of the file, narrowed by the words typed, Enter to
 * go there.
 *
 * Mounted only while open, so the rows are built from the buffer as it is
 * now rather than kept in step with every keystroke in the editor.
 */
function LineSearch({
  text,
  line,
  onClose,
  onPick,
}: {
  text: string
  line: number
  onClose: () => void
  onPick: (line: number) => void
}) {
  const filter = React.useCallback(
    (query: string): PickerItem[] =>
      matchLines(text, query).map((match) => ({
        value: String(match.line),
        label: (
          <>
            <span className="text-muted-foreground w-10 shrink-0 text-right font-mono text-xs">
              {match.line}
            </span>
            <span className="truncate font-mono text-xs">{match.text.trim()}</span>
          </>
        ),
      })),
    [text],
  )

  return (
    <LeaderPicker
      open
      onOpenChange={(open) => !open && onClose()}
      title="Search buffer"
      placeholder="Search lines…"
      items={[]}
      filter={filter}
      initialValue={String(line)}
      onPick={(value) => onPick(Number(value))}
      empty="No matching lines."
    />
  )
}

/** Rows for a list of paths: icon, name, and the folder it is in. */
function fileItems(paths: readonly string[], hint?: (path: string) => string | undefined): PickerItem[] {
  return paths.map((path) => {
    const note = hint?.(path)
    const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
    return {
      value: path,
      keywords: [basename(path)],
      label: (
        <>
          <FileTypeIcon name={basename(path)} kind="file" />
          <span className="truncate">{basename(path)}</span>
          {folder && <span className="text-muted-foreground truncate text-xs">{folder}</span>}
          {note && <span className="text-ucch-active ml-auto shrink-0 text-xs">{note}</span>}
        </>
      ),
    }
  })
}
