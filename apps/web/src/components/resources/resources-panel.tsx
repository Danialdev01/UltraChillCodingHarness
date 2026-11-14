"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronRightIcon,
  CloudIcon,
  DownloadIcon,
  FolderPlusIcon,
  HardDriveIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react"
import type { ResourceEntry, ResourceStoreSummary, WorkspacePermission } from "@ucch/protocol"
import { WORKSPACE_STORE_ID } from "@ucch/protocol/plain"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { FIELD, FormDialog, FormDialogFooter, FormField } from "@/components/form-dialog"
import { FileTypeIcon } from "@/components/file-type-icon"
import { TreeRowsSkeleton } from "@/components/page-skeletons"
import { S3StoreDialog } from "@/components/resources/s3-store-dialog"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarGroupLabel } from "@/components/ui/sidebar"
import { useToast } from "@/lib/realtime"
import {
  createResourceFolder,
  deleteResource,
  fetchStores,
  listFolder,
  moveResource,
  removeStore,
  resourceContentUrl,
  resourceKeys,
  uploadResource,
  writeResourceDrag,
} from "@/lib/resources-api"
import { cn } from "@/lib/utils"

/** What a dialog in the panel is about. One at a time, so one piece of state. */
type Pending =
  | { kind: "new-folder"; store: ResourceStoreSummary; parent: string }
  | { kind: "rename"; store: ResourceStoreSummary; entry: ResourceEntry }
  | { kind: "delete"; store: ResourceStoreSummary; entry: ResourceEntry }
  | { kind: "add-s3" }
  | { kind: "edit-s3"; store: ResourceStoreSummary }
  | { kind: "remove-store"; store: ResourceStoreSummary }

interface PanelContextValue {
  workspaceId: string
  canWrite: boolean
  canManage: boolean
  ask: (pending: Pending) => void
  /** Uploads files into a folder of a store, a toast for each failure. */
  upload: (store: ResourceStoreSummary, prefix: string, files: FileList | File[]) => Promise<void>
  /** Refetches one folder's listing. */
  refresh: (storeId: string, prefix?: string) => void
}

const PanelContext = React.createContext<PanelContextValue | null>(null)
function usePanel(): PanelContextValue {
  return React.useContext(PanelContext)!
}

const parentOf = (key: string) => (key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "")
const joinKey = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name)

/** Only desktop files: a resource row or a tree row dragged over is not an upload. */
const carriesDesktopFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files")

/**
 * The workspace's Resources, in the sidebar's second column.
 *
 * Opened from the folder icon on the rail, beside whatever page is open, so
 * a file here can be dragged straight into the chat (it is attached as a
 * copy) or onto a folder in the file tree (it is copied into the project).
 *
 * Each store is a collapsible group, the way Settled and Archived are under
 * the session list: the workspace's own disk storage first and always, then
 * every S3 bucket the workspace has added.
 */
export function ResourcesPanel({
  workspaceId,
  permissions,
}: {
  workspaceId: string
  permissions: readonly WorkspacePermission[]
}) {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [pending, setPending] = React.useState<Pending | null>(null)
  const canWrite = permissions.includes("project.write")
  const canManage = permissions.includes("credentials.manage")

  const stores = useQuery({
    queryKey: resourceKeys.stores(workspaceId),
    queryFn: () => fetchStores(workspaceId),
    enabled: workspaceId !== "",
  })

  const refresh = React.useCallback(
    (storeId: string, prefix?: string) => {
      void queryClient.invalidateQueries({
        queryKey:
          prefix === undefined ? resourceKeys.store(workspaceId, storeId) : resourceKeys.folder(workspaceId, storeId, prefix),
      })
    },
    [queryClient, workspaceId],
  )

  const upload = React.useCallback(
    async (store: ResourceStoreSummary, prefix: string, files: FileList | File[]) => {
      const list = [...files]
      if (list.length === 0) return
      const results = await Promise.allSettled(
        list.map((file) => uploadResource(workspaceId, store.id, joinKey(prefix, file.name), file)),
      )
      results.forEach((r) => {
        if (r.status === "rejected") {
          toast({ title: "Upload failed", description: r.reason instanceof Error ? r.reason.message : undefined, tone: "error" })
        }
      })
      const done = results.filter((r) => r.status === "fulfilled").length
      if (done > 0) toast({ title: done === 1 ? `Uploaded ${list[0]!.name}` : `Uploaded ${done} files` })
      refresh(store.id, prefix)
    },
    [workspaceId, toast, refresh],
  )

  const value = React.useMemo(
    () => ({ workspaceId, canWrite, canManage, ask: setPending, upload, refresh }),
    [workspaceId, canWrite, canManage, upload, refresh],
  )

  const close = (open: boolean) => !open && setPending(null)

  return (
    <PanelContext.Provider value={value}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between pr-2">
          <SidebarGroupLabel className="px-4">Resources</SidebarGroupLabel>
          {canManage && (
            <button
              type="button"
              onClick={() => setPending({ kind: "add-s3" })}
              className="text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex items-center gap-1 rounded-md px-1.5 py-1 text-xs outline-none focus-visible:ring-2"
              title="Add S3 storage"
            >
              <PlusIcon className="size-3.5" aria-hidden />
              Add storage
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {stores.isPending ? (
            <TreeRowsSkeleton rows={4} />
          ) : stores.isError ? (
            <p className="text-destructive px-2 py-2 text-xs">{stores.error.message}</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {stores.data.map((store) => (
                <StoreGroup key={store.id} store={store} />
              ))}
            </div>
          )}
          <p className="text-muted-foreground px-2 pt-3 text-[11px] leading-snug">
            Drag a file into the chat to attach it, or onto a folder in the file tree to copy it into the project.
          </p>
        </div>
      </div>

      {pending?.kind === "new-folder" && (
        <NameDialog
          title="New folder"
          icon={FolderPlusIcon}
          initial=""
          submitLabel="Create"
          onClose={close}
          onSubmit={async (name) => {
            await createResourceFolder(workspaceId, pending.store.id, joinKey(pending.parent, name))
            refresh(pending.store.id, pending.parent)
          }}
        />
      )}
      {pending?.kind === "rename" && (
        <NameDialog
          title={`Rename ${pending.entry.name}`}
          icon={PencilIcon}
          initial={pending.entry.name}
          submitLabel="Rename"
          onClose={close}
          onSubmit={async (name) => {
            const parent = parentOf(pending.entry.key)
            await moveResource(workspaceId, pending.store.id, pending.entry.key, joinKey(parent, name))
            refresh(pending.store.id, parent)
          }}
        />
      )}
      {pending?.kind === "delete" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`Delete ${pending.entry.name}?`}
          description={
            pending.entry.kind === "folder"
              ? "The folder and everything in it are deleted for the whole workspace."
              : "The file is deleted for the whole workspace."
          }
          onConfirm={async () => {
            await deleteResource(workspaceId, pending.store.id, pending.entry.key)
            refresh(pending.store.id, parentOf(pending.entry.key))
          }}
        />
      )}
      {pending?.kind === "remove-store" && (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={`Remove ${pending.store.name}?`}
          confirmLabel="Remove"
          description="The workspace forgets this bucket. Its files stay in the bucket untouched."
          onConfirm={async () => {
            await removeStore(workspaceId, pending.store.id)
            void queryClient.invalidateQueries({ queryKey: resourceKeys.stores(workspaceId) })
          }}
        />
      )}
      {(pending?.kind === "add-s3" || pending?.kind === "edit-s3") && (
        <S3StoreDialog
          open
          onOpenChange={close}
          workspaceId={workspaceId}
          store={pending.kind === "edit-s3" ? pending.store : undefined}
          onSaved={() => {
            void queryClient.invalidateQueries({ queryKey: resourceKeys.stores(workspaceId) })
            if (pending.kind === "edit-s3") refresh(pending.store.id)
          }}
        />
      )}
    </PanelContext.Provider>
  )
}

/** One store: a collapsible header with its actions, and its root folder below. */
function StoreGroup({ store }: { store: ResourceStoreSummary }) {
  const { canWrite, canManage, ask, upload } = usePanel()
  const [open, setOpen] = React.useState(store.id === WORKSPACE_STORE_ID)
  const [dropping, setDropping] = React.useState(false)
  const picker = React.useRef<HTMLInputElement>(null)
  const Icon = store.kind === "local" ? HardDriveIcon : CloudIcon
  const subtitle = store.s3 ? `${store.s3.bucket}${store.s3.prefix ? `/${store.s3.prefix}` : ""}` : null

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={cn("group/store relative rounded-md", dropping && "ring-primary bg-primary/5 ring-1")}
        onDragOver={(e) => {
          if (!canWrite || !carriesDesktopFiles(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "copy"
          setDropping(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
        }}
        onDrop={(e) => {
          if (!canWrite || !carriesDesktopFiles(e)) return
          e.preventDefault()
          setDropping(false)
          setOpen(true)
          void upload(store, "", e.dataTransfer.files)
        }}
      >
        <CollapsibleTrigger className="hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex w-full items-center gap-2 rounded-md px-2 py-2 pr-8 text-left text-xs font-medium outline-none focus-visible:ring-2">
          <ChevronRightIcon aria-hidden className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
          <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{store.name}</span>
            {subtitle && <span className="text-muted-foreground truncate text-[10.5px] font-normal">{subtitle}</span>}
          </span>
        </CollapsibleTrigger>
        {(canWrite || (canManage && store.kind === "s3")) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="text-muted-foreground hover:text-foreground hover:bg-background/70 focus-visible:ring-sidebar-ring absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md outline-none focus-visible:ring-2"
              aria-label={`${store.name} actions`}
            >
              <MoreHorizontalIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {canWrite && (
                <>
                  <DropdownMenuItem onClick={() => picker.current?.click()}>
                    <UploadIcon /> Upload files…
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => ask({ kind: "new-folder", store, parent: "" })}>
                    <FolderPlusIcon /> New folder…
                  </DropdownMenuItem>
                </>
              )}
              {canManage && store.kind === "s3" && (
                <>
                  {canWrite && <DropdownMenuSeparator />}
                  <DropdownMenuItem onClick={() => ask({ kind: "edit-s3", store })}>
                    <PencilIcon /> Edit storage…
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={() => ask({ kind: "remove-store", store })}>
                    <Trash2Icon /> Remove storage…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) {
              setOpen(true)
              void upload(store, "", e.target.files)
            }
            e.target.value = ""
          }}
        />
      </div>
      <CollapsibleContent>
        {open && <Folder store={store} prefix="" depth={0} />}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** One folder's listing, fetched when it is first opened. */
function Folder({ store, prefix, depth }: { store: ResourceStoreSummary; prefix: string; depth: number }) {
  const { workspaceId } = usePanel()
  const listing = useQuery({
    queryKey: resourceKeys.folder(workspaceId, store.id, prefix),
    queryFn: () => listFolder(workspaceId, store.id, prefix),
  })

  if (listing.isPending) return <TreeRowsSkeleton rows={3} dense />
  if (listing.isError) {
    return (
      <p className="text-destructive py-1 text-xs" style={{ paddingLeft: indent(depth) }}>
        {listing.error.message}
      </p>
    )
  }
  if (listing.data.length === 0) {
    return (
      <p className="text-muted-foreground py-1 text-xs" style={{ paddingLeft: indent(depth) }}>
        {depth === 0 ? "Empty. Drop files here to upload them." : "Empty folder."}
      </p>
    )
  }
  return (
    <ul className="flex flex-col">
      {listing.data.map((entry) => (
        <EntryRow key={entry.key} store={store} entry={entry} depth={depth} />
      ))}
    </ul>
  )
}

const indent = (depth: number) => `${0.5 + depth * 0.875}rem`

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** A file or folder. Draggable into the chat and the file tree; a folder opens in place. */
function EntryRow({ store, entry, depth }: { store: ResourceStoreSummary; entry: ResourceEntry; depth: number }) {
  const { workspaceId, canWrite, ask, upload } = usePanel()
  const [open, setOpen] = React.useState(false)
  const [dropping, setDropping] = React.useState(false)
  const picker = React.useRef<HTMLInputElement>(null)
  const folder = entry.kind === "folder"
  const download = folder ? null : resourceContentUrl(workspaceId, store.id, entry.key, { download: true })

  const row = (
    <div
      role={folder ? "button" : undefined}
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        writeResourceDrag(e.dataTransfer, { workspaceId, storeId: store.id, key: entry.key, name: entry.name, kind: entry.kind })
      }}
      onClick={folder ? () => setOpen((o) => !o) : undefined}
      onKeyDown={(e) => {
        if (folder && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault()
          setOpen((o) => !o)
        }
      }}
      onDragOver={(e) => {
        if (!folder || !canWrite || !carriesDesktopFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = "copy"
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        if (!folder || !canWrite || !carriesDesktopFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        setDropping(false)
        setOpen(true)
        void upload(store, entry.key, e.dataTransfer.files)
      }}
      title={folder ? entry.name : `${entry.name}${entry.size !== undefined ? ` · ${formatSize(entry.size)}` : ""}`}
      className={cn(
        "group/row hover:bg-sidebar-accent focus-visible:ring-sidebar-ring relative flex h-7 cursor-default items-center gap-1.5 rounded-md pr-8 text-[13px] outline-none select-none focus-visible:ring-2 active:cursor-grabbing",
        dropping && "ring-primary bg-primary/5 ring-1",
      )}
      style={{ paddingLeft: indent(depth) }}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
        {folder && <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />}
      </span>
      <FileTypeIcon name={entry.name} kind={folder ? (open ? "folder-open" : "folder") : "file"} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
      {!folder && entry.size !== undefined && (
        <span className="text-muted-foreground shrink-0 text-[10.5px] tabular-nums group-hover/row:hidden">
          {formatSize(entry.size)}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:text-foreground hover:bg-background/70 focus-visible:ring-sidebar-ring absolute right-1 grid size-6 place-items-center rounded-md opacity-0 outline-none group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 data-[popup-open]:opacity-100"
          aria-label={`${entry.name} actions`}
        >
          <MoreHorizontalIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {download && (
            <DropdownMenuItem render={<a href={download} download={entry.name} />}>
              <DownloadIcon /> Download
            </DropdownMenuItem>
          )}
          {folder && canWrite && (
            <>
              <DropdownMenuItem onClick={() => picker.current?.click()}>
                <UploadIcon /> Upload files here…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => ask({ kind: "new-folder", store, parent: entry.key })}>
                <FolderPlusIcon /> New folder…
              </DropdownMenuItem>
            </>
          )}
          {canWrite && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => ask({ kind: "rename", store, entry })}>
                <PencilIcon /> Rename…
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => ask({ kind: "delete", store, entry })}>
                <Trash2Icon /> Delete…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {folder && (
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) {
              setOpen(true)
              void upload(store, entry.key, e.target.files)
            }
            e.target.value = ""
          }}
        />
      )}
    </div>
  )

  return (
    <li>
      {row}
      {folder && open && <Folder store={store} prefix={entry.key} depth={depth + 1} />}
    </li>
  )
}

/** Asks for one name: a new folder's, or a new name for a row. */
function NameDialog({
  title,
  icon,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  title: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  initial: string
  submitLabel: string
  onClose: (open: boolean) => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const trimmed = name.trim()
  const valid = trimmed !== "" && !trimmed.includes("/") && trimmed !== "." && trimmed !== ".."

  return (
    <FormDialog
      open
      onOpenChange={onClose}
      busy={busy}
      icon={icon}
      title={title}
      description="Shared with everyone in the workspace."
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid || busy) return
        setBusy(true)
        setError(null)
        try {
          await onSubmit(trimmed)
          onClose(false)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }}
      footer={
        <FormDialogFooter busy={busy} disabled={!valid || trimmed === initial}>
          {submitLabel}
        </FormDialogFooter>
      }
    >
      <FormField label="Name" htmlFor="resource-name" error={error}>
        <input
          id="resource-name"
          className={FIELD}
          value={name}
          autoFocus
          onFocus={(e) => {
            // Select the stem, so typing replaces the name and keeps the extension.
            const dot = e.target.value.lastIndexOf(".")
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
          }}
          onChange={(e) => setName(e.target.value)}
        />
      </FormField>
    </FormDialog>
  )
}
