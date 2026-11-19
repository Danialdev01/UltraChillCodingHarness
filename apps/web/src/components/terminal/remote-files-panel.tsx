"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowUpIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  FolderPlusIcon,
  HomeIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import type { RemoteEntry, SshHostSummary } from "@ucch/protocol"
import { normalizeRemotePath, remoteJoin, remoteParent } from "@ucch/protocol/plain"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { FileTypeIcon } from "@/components/file-type-icon"
import { ListRowsSkeleton } from "@/components/page-skeletons"
import { RemoteFileEditor } from "@/components/terminal/remote-file-editor"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { qk } from "@/lib/query-keys"
import {
  createRemoteFolder,
  deleteRemoteEntry,
  listRemoteFolder,
  moveRemoteEntry,
  remoteFileUrl,
  uploadRemoteFile,
} from "@/lib/ssh-api"
import { useInvalidate } from "@/lib/use-invalidate"
import { cn } from "@/lib/utils"

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/**
 * The focused pane's server, over SFTP: one folder at a time, starting at
 * the login's home, as a file manager in a sidebar does it.
 *
 * Files drop in from the desktop to upload; a text file opens in an editor
 * that saves back to the server, and refuses to save over a change someone
 * made in a shell meanwhile.
 */
export function RemoteFilesPanel({ host, onClose }: { host: SshHostSummary | null; onClose: () => void }) {
  return (
    <aside aria-label="Server files" className="bg-sidebar/40 flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-xs">
        <FolderIcon className="text-muted-foreground size-3.5" />
        <span className="truncate font-medium">{host ? `${host.name} files` : "Files"}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:bg-muted hover:text-foreground ml-auto flex size-6 items-center justify-center rounded-md"
        >
          <XIcon className="size-3.5" />
          <span className="sr-only">Close files</span>
        </button>
      </div>
      {host ? (
        <Browser key={host.id} host={host} />
      ) : (
        <p className="text-muted-foreground p-4 text-sm">Open a terminal, and its server&apos;s files show here.</p>
      )}
    </aside>
  )
}

function Browser({ host }: { host: SshHostSummary }) {
  const invalidate = useInvalidate()
  // "" until the server says where home is.
  const [path, setPath] = React.useState("")
  const [typed, setTyped] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [renaming, setRenaming] = React.useState<RemoteEntry | null>(null)
  const [removing, setRemoving] = React.useState<RemoteEntry | null>(null)
  const [creating, setCreating] = React.useState(false)
  const [editing, setEditing] = React.useState<string | null>(null)
  const upload = React.useRef<HTMLInputElement>(null)

  const listing = useQuery({
    queryKey: qk.sshHosts.folder(host.id, path),
    queryFn: () => listRemoteFolder(host.id, path),
  })
  const shown = listing.data?.path ?? path
  const home = listing.data?.home ?? "/"

  // The real path once the server has resolved home, so the key is stable.
  React.useEffect(() => {
    if (path === "" && listing.data) setPath(listing.data.path)
  }, [path, listing.data])

  const refresh = () => invalidate(qk.sshHosts.host(host.id))

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label)
    setError(null)
    try {
      await action()
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    const list = [...files]
    if (list.length === 0) return
    await run(list.length === 1 ? `Uploading ${list[0]!.name}` : `Uploading ${list.length} files`, async () => {
      for (const file of list) await uploadRemoteFile(host.id, remoteJoin(shown, file.name), file)
    })
  }

  function go(next: string) {
    const normalized = normalizeRemotePath(next, home)
    if (normalized) setPath(normalized)
    setTyped(null)
    setError(null)
  }

  return (
    <div
      className={cn("relative flex min-h-0 flex-1 flex-col", dragging && "ring-ucch-active/60 ring-2 ring-inset")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return
        event.preventDefault()
        setDragging(false)
        void uploadFiles(event.dataTransfer.files)
      }}
    >
      <div className="flex shrink-0 items-center gap-0.5 border-b px-1 py-1">
        <ToolButton label="Up" disabled={shown === "/"} onClick={() => go(remoteParent(shown))}>
          <ArrowUpIcon />
        </ToolButton>
        <ToolButton label="Home" onClick={() => go(home)}>
          <HomeIcon />
        </ToolButton>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (typed !== null) go(typed)
          }}
        >
          <input
            aria-label="Path"
            value={typed ?? shown}
            onChange={(e) => setTyped(e.target.value)}
            onBlur={() => setTyped(null)}
            spellCheck={false}
            className="focus-visible:border-ucch-active/60 focus-visible:ring-ucch-active/20 h-6 w-full rounded-md border border-transparent bg-transparent px-1.5 font-mono text-[11px] outline-none focus-visible:bg-background focus-visible:ring-2"
          />
        </form>
        <ToolButton label="Refresh" onClick={refresh}>
          <RefreshCwIcon className={cn(listing.isFetching && "animate-spin")} />
        </ToolButton>
        <ToolButton label="New folder" onClick={() => setCreating(true)}>
          <FolderPlusIcon />
        </ToolButton>
        <ToolButton label="Upload" onClick={() => upload.current?.click()}>
          <UploadIcon />
        </ToolButton>
        <input
          ref={upload}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files)
            e.target.value = ""
          }}
        />
      </div>

      {(busy || error) && (
        <div className={cn("flex items-center gap-1.5 border-b px-2 py-1.5 text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {busy && <Loader2Icon className="size-3 animate-spin" />}
          <span role={error ? "alert" : undefined} className="break-words">
            {error ?? busy}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {listing.isPending ? (
          <ListRowsSkeleton rows={8} className="flex flex-col gap-2 px-3 py-2" />
        ) : listing.error ? (
          <div className="p-3 text-xs">
            <p role="alert" className="text-destructive break-words">
              {listing.error.message}
            </p>
            <button type="button" className="text-muted-foreground mt-1 underline" onClick={refresh}>
              Retry
            </button>
          </div>
        ) : listing.data.entries.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">Empty folder. Drop files here to upload them.</p>
        ) : (
          <ul>
            {listing.data.entries.map((entry) => (
              <EntryRow
                key={entry.path}
                entry={entry}
                hostId={host.id}
                onOpen={() => (entry.kind === "folder" ? go(entry.path) : setEditing(entry.path))}
                onRename={() => setRenaming(entry)}
                onRemove={() => setRemoving(entry)}
              />
            ))}
            {listing.data.truncated && (
              <li className="text-muted-foreground px-3 py-2 text-xs">Showing the first 5,000 entries.</li>
            )}
          </ul>
        )}
      </div>

      <NameDialog
        open={creating}
        title="New folder"
        initial=""
        confirm="Create"
        onClose={() => setCreating(false)}
        onSubmit={(name) => run(`Creating ${name}`, () => createRemoteFolder(host.id, remoteJoin(shown, name)))}
      />
      <NameDialog
        open={renaming !== null}
        title={`Rename ${renaming?.name ?? ""}`}
        initial={renaming?.name ?? ""}
        confirm="Rename"
        onClose={() => setRenaming(null)}
        onSubmit={(name) =>
          renaming
            ? run(`Renaming ${renaming.name}`, () => moveRemoteEntry(host.id, renaming.path, remoteJoin(remoteParent(renaming.path), name)))
            : Promise.resolve()
        }
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Delete ${removing?.name ?? ""}?`}
        description={
          removing?.kind === "folder"
            ? "The folder and everything in it is deleted from the server. This cannot be undone."
            : "The file is deleted from the server. This cannot be undone."
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!removing) return
          await deleteRemoteEntry(host.id, removing.path)
          refresh()
        }}
      />
      {editing && (
        <RemoteFileEditor hostId={host.id} hostName={host.name} path={editing} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
    </div>
  )
}

function EntryRow({
  entry,
  hostId,
  onOpen,
  onRename,
  onRemove,
}: {
  entry: RemoteEntry
  hostId: string
  onOpen: () => void
  onRename: () => void
  onRemove: () => void
}) {
  return (
    <li className="group/row hover:bg-muted/60 flex items-center gap-1 pr-1 pl-2">
      <button
        type="button"
        onClick={onOpen}
        title={entry.path}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left text-[13px]"
      >
        {entry.kind === "folder" ? (
          <FolderIcon className="text-muted-foreground size-4 shrink-0" />
        ) : entry.kind === "link" ? (
          <FileIcon className="text-muted-foreground size-4 shrink-0" />
        ) : (
          <FileTypeIcon name={entry.name} className="size-4 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
        <span className="text-muted-foreground ml-auto shrink-0 text-[11px] tabular-nums">{formatSize(entry.size)}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted aria-expanded:bg-muted flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 group-hover/row:opacity-100 aria-expanded:opacity-100"
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
          <span className="sr-only">More for {entry.name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44" align="end">
          {entry.kind !== "folder" && (
            <DropdownMenuItem render={<a href={remoteFileUrl(hostId, entry.path, true)} download={entry.name} />}>
              <DownloadIcon className="text-muted-foreground" />
              <span>Download</span>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={onRename}>
            <PencilIcon className="text-muted-foreground" />
            <span>Rename</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <Trash2Icon />
            <span>Delete</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

function ToolButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-md disabled:opacity-40 [&_svg]:size-3.5"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  )
}

/** Asks for a file or folder name: one segment, no slashes. */
function NameDialog({
  open,
  title,
  initial,
  confirm,
  onClose,
  onSubmit,
}: {
  open: boolean
  title: string
  initial: string
  confirm: string
  onClose: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = React.useState(initial)
  React.useEffect(() => {
    if (open) setName(initial)
  }, [open, initial])
  const valid = name.trim() !== "" && !name.includes("/") && name !== "." && name !== ".."
  if (!open) return null
  return (
    <div className="bg-background/80 absolute inset-0 z-20 flex items-start justify-center p-3 pt-12 backdrop-blur-[1px]">
      <form
        className="bg-popover flex w-full max-w-xs flex-col gap-2 rounded-lg border p-3 shadow-lg"
        onSubmit={(event) => {
          event.preventDefault()
          if (!valid) return
          onClose()
          void onSubmit(name.trim())
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
        }}
      >
        <label htmlFor="remote-name" className="text-xs font-medium">
          {title}
        </label>
        <input
          id="remote-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          spellCheck={false}
          className="focus-visible:border-ucch-active focus-visible:ring-ucch-active/20 h-8 rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="hover:bg-muted rounded-md px-2.5 py-1 text-xs">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid}
            className="bg-primary text-primary-foreground rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-40"
          >
            {confirm}
          </button>
        </div>
      </form>
    </div>
  )
}
