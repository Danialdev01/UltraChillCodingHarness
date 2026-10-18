"use client"

import * as React from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { ChevronRightIcon, FileIcon } from "lucide-react"

import { FileTypeIcon } from "@/components/file-type-icon"
import { CodeLinesSkeleton, ListRowsSkeleton } from "@/components/page-skeletons"
import type { FileNode } from "@/lib/files-api"
import { highlightLines } from "@/lib/highlight-lines"
import { PublicApiError, fetchPublicFile, fetchPublicTree } from "@/lib/public-api"
import { cn } from "@/lib/utils"
import { useTransitionRouter } from "@/lib/view-transitions"

/**
 * The project's files, to look at.
 *
 * A tree on the left and the file on the right, addressed by `?path=` so a
 * link to one file can be shared. Text is coloured with the editor's own
 * grammar and nothing here can be typed into; what cannot be shown as text
 * says so rather than being offered for download.
 */
export function PublicDocuments({ slug }: { slug: string }) {
  const router = useTransitionRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const path = params.get("path")
  const [tree, setTree] = React.useState<{ tree: FileNode[]; truncated: boolean } | null>(null)
  const [file, setFile] = React.useState<{ path: string; content: string } | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState<Set<string>>(() => new Set())

  React.useEffect(() => {
    fetchPublicTree(slug).then(setTree, (e) => setError(e instanceof Error ? e.message : "Could not load."))
  }, [slug])

  // Folders along the way to the open file start open.
  React.useEffect(() => {
    if (!path) return
    setOpen((prev) => {
      const next = new Set(prev)
      const parts = path.split("/")
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/"))
      return next
    })
  }, [path])

  React.useEffect(() => {
    if (!path) {
      setFile(null)
      setFileError(null)
      return
    }
    let cancelled = false
    setFileError(null)
    fetchPublicFile(slug, path).then(
      (loaded) => !cancelled && setFile(loaded),
      (e) => {
        if (cancelled) return
        setFile(null)
        setFileError(
          e instanceof PublicApiError && e.status === 415
            ? "This file is not text, so there is nothing to show."
            : e instanceof Error
              ? e.message
              : "Could not open the file.",
        )
      },
    )
    return () => {
      cancelled = true
    }
  }, [slug, path])

  const select = (p: string) => router.push(`${pathname}?path=${encodeURIComponent(p)}`)

  return (
    <>
      <aside className="bg-sidebar/40 flex w-64 shrink-0 flex-col overflow-y-auto border-r py-2">
        {error ? (
          <p className="text-muted-foreground px-3 text-xs">{error}</p>
        ) : tree ? (
          <>
            <Tree nodes={tree.tree} prefix="" depth={0} open={open} onToggle={(p) => setOpen((s) => toggled(s, p))} selected={path} onSelect={select} />
            {tree.truncated && <p className="text-muted-foreground px-3 pt-2 text-xs">Some files are not listed.</p>}
          </>
        ) : (
          <ListRowsSkeleton rows={8} className="flex flex-col gap-2 px-3 py-2" />
        )}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {path ? (
          <>
            <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs">
              <FileTypeIcon name={path} kind="file" className="size-3.5" />
              <span className="truncate font-medium">{path}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {fileError ? (
                <p className="text-muted-foreground p-8 text-sm">{fileError}</p>
              ) : file && file.path === path ? (
                <CodeView content={file.content} path={path} />
              ) : (
                <CodeLinesSkeleton />
              )}
            </div>
          </>
        ) : (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-sm">
            <FileIcon className="size-8 opacity-40" />
            <p>Pick a file to read it.</p>
          </div>
        )}
      </div>
    </>
  )
}

function toggled(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

function Tree({
  nodes,
  prefix,
  depth,
  open,
  onToggle,
  selected,
  onSelect,
}: {
  nodes: FileNode[]
  prefix: string
  depth: number
  open: Set<string>
  onToggle(path: string): void
  selected: string | null
  onSelect(path: string): void
}) {
  return (
    <ul>
      {nodes.map((node) => {
        const path = prefix ? `${prefix}/${node.name}` : node.name
        const folder = node.children !== undefined
        const expanded = open.has(path)
        const active = path === selected
        return (
          <li key={path}>
            <button
              type="button"
              onClick={() => (folder ? onToggle(path) : onSelect(path))}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs",
                active ? "bg-ucch-active-bg text-ucch-active" : "text-muted-foreground hover:bg-muted/60",
              )}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {folder ? (
                <ChevronRightIcon className={cn("text-muted-foreground size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <FileTypeIcon name={node.name} kind={folder ? (expanded ? "folder-open" : "folder") : "file"} className="size-3.5 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
            {folder && expanded && node.children!.length > 0 && (
              <Tree nodes={node.children!} prefix={path} depth={depth + 1} open={open} onToggle={onToggle} selected={selected} onSelect={onSelect} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** A file's text with line numbers, coloured by the editor's grammar. */
function CodeView({ content, path }: { content: string; path: string }) {
  const lines = React.useMemo(() => highlightLines(content, path), [content, path])
  return (
    <table className="w-full border-collapse font-mono text-xs leading-5">
      <tbody>
        {lines.map((tokens, i) => (
          <tr key={i}>
            <td className="text-text-subtle w-10 min-w-10 border-r px-2 text-right align-top select-none">{i + 1}</td>
            <td className="w-full px-3 whitespace-pre">
              {tokens.map((t, k) => (
                <span key={k} className={t.cls || undefined}>
                  {t.text}
                </span>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
