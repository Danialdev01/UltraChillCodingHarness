"use client"

import * as React from "react"
import type { GitDiff } from "@ucch/protocol"
import { FileIcon } from "lucide-react"

import { FileTypeIcon } from "@/components/file-type-icon"
import { parseConflict, parsePatch, sidesOf, type DiffFile, type DiffLine } from "@/lib/git-diff"
import { highlightLines, type Token } from "@/lib/highlight-lines"
import { cn } from "@/lib/utils"

/**
 * A unified diff, one file at a time.
 *
 * Two gutters of line numbers, then the line, tinted by side. The text is
 * coloured by the same grammar the editor uses: each side of the file is
 * rebuilt from the hunks and highlighted as one piece, so a construct that
 * spans lines is coloured as one thing, then dealt back out by line number.
 */
export function DiffView({ diff, path }: { diff: GitDiff; path: string }) {
  if (diff.conflict) return <ConflictDiffView content={diff.content} path={path} truncated={diff.truncated} />
  if (diff.binary) return <Notice>Binary file; nothing to show.</Notice>
  if (!diff.patch.trim()) return <Notice>No changes.</Notice>
  return <PatchView patch={diff.patch} path={path} truncated={diff.truncated} />
}

function PatchView({ patch, path, truncated }: { patch: string; path: string; truncated: boolean }) {
  const files = React.useMemo(() => parsePatch(patch), [patch])
  return (
    <div className="min-w-0">
      {files.map((file, i) => (
        <FileDiff key={`${file.oldPath ?? ""}→${file.newPath ?? ""}#${i}`} file={file} path={path} />
      ))}
      {truncated && <Notice>The diff is longer than this; the rest is not shown.</Notice>}
    </div>
  )
}

function FileDiff({ file, path }: { file: DiffFile; path: string }) {
  const highlightPath = file.newPath ?? file.oldPath ?? path
  const tokens = React.useMemo(() => {
    const sides = sidesOf(file)
    return {
      old: highlightLines(sides.oldText, highlightPath),
      new: highlightLines(sides.newText, highlightPath),
      oldIndex: sides.oldIndex,
      newIndex: sides.newIndex,
    }
  }, [file, highlightPath])

  const tokensFor = (line: DiffLine): Token[] => {
    if (line.newNo !== undefined) {
      const at = tokens.newIndex.get(line.newNo)
      if (at !== undefined) return tokens.new[at] ?? []
    }
    if (line.oldNo !== undefined) {
      const at = tokens.oldIndex.get(line.oldNo)
      if (at !== undefined) return tokens.old[at] ?? []
    }
    return line.text ? [{ text: line.text, cls: "" }] : []
  }

  const renamed = file.oldPath && file.newPath && file.oldPath !== file.newPath
  return (
    <div className="border-b last:border-b-0">
      <div className="bg-background/95 sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-1.5 text-xs backdrop-blur">
        <FileTypeIcon name={file.newPath ?? file.oldPath ?? path} kind="file" className="size-3.5 shrink-0" />
        <span className="truncate font-medium">
          {renamed ? (
            <>
              <span className="text-muted-foreground">{file.oldPath}</span> → {file.newPath}
            </>
          ) : (
            (file.newPath ?? file.oldPath ?? path)
          )}
        </span>
        {file.oldPath === null && <Badge tone="add">new file</Badge>}
        {file.newPath === null && <Badge tone="del">deleted</Badge>}
      </div>
      {file.hunks.length === 0 && <Notice>No content changes.</Notice>}
      <table className="w-full border-collapse font-mono text-xs leading-5">
        <tbody>
          {file.hunks.map((hunk, h) => (
            <React.Fragment key={h}>
              <tr className="bg-muted/60 text-muted-foreground">
                <td colSpan={3} className="px-3 py-0.5 select-none">
                  {hunk.header}
                </td>
              </tr>
              {hunk.lines.map((line, i) => (
                <tr
                  key={i}
                  className={cn(
                    line.kind === "add" && "bg-[color-mix(in_oklch,var(--ucch-note-green)_18%,transparent)]",
                    line.kind === "del" && "bg-[color-mix(in_oklch,var(--ucch-note-red)_18%,transparent)]",
                  )}
                >
                  <Gutter no={line.oldNo} />
                  <Gutter no={line.newNo} />
                  <td className="w-full px-2 whitespace-pre">
                    <span className="text-muted-foreground mr-2 inline-block w-3 select-none">
                      {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                    </span>
                    {tokensFor(line).map((token, t) => (
                      <span key={t} className={token.cls || undefined}>
                        {token.text}
                      </span>
                    ))}
                    {line.noNewline && (
                      <span className="text-muted-foreground ml-2 select-none italic">(no newline at end)</span>
                    )}
                  </td>
                </tr>
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A working copy with merge markers in it.
 *
 * The file is shown as it is on disk, so what a person sees is exactly what
 * "mark resolved" would commit. Ours and theirs are tinted, and the marker
 * lines are dimmed so the two sides read as the content.
 */
function ConflictDiffView({ content, path, truncated }: { content: string; path: string; truncated: boolean }) {
  const parsed = React.useMemo(() => parseConflict(content), [content])
  const tokens = React.useMemo(() => highlightLines(content, path), [content, path])
  return (
    <div className="min-w-0">
      <div className="bg-background/95 sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-1.5 text-xs backdrop-blur">
        <FileTypeIcon name={path} kind="file" className="size-3.5 shrink-0" />
        <span className="truncate font-medium">{path}</span>
        <Badge tone="conflict">
          {parsed.conflicts} {parsed.conflicts === 1 ? "conflict" : "conflicts"}
        </Badge>
        <span className="text-muted-foreground ml-auto hidden sm:inline">
          <span className="rounded bg-[color-mix(in_oklch,var(--ucch-note-blue)_25%,transparent)] px-1">ours</span>{" "}
          <span className="rounded bg-[color-mix(in_oklch,var(--ucch-note-purple)_25%,transparent)] px-1">theirs</span>
        </span>
      </div>
      <table className="w-full border-collapse font-mono text-xs leading-5">
        <tbody>
          {parsed.lines.map((line) => (
            <tr
              key={line.no}
              className={cn(
                line.side === "ours" && "bg-[color-mix(in_oklch,var(--ucch-note-blue)_18%,transparent)]",
                line.side === "theirs" && "bg-[color-mix(in_oklch,var(--ucch-note-purple)_18%,transparent)]",
                line.side === "base" && "bg-muted/60",
                line.side === "marker" && "bg-muted text-muted-foreground font-semibold",
              )}
            >
              <Gutter no={line.no} />
              <td className="w-full px-3 whitespace-pre">
                {line.side === "marker"
                  ? line.text
                  : (tokens[line.no - 1] ?? [{ text: line.text, cls: "" }]).map((token, t) => (
                      <span key={t} className={token.cls || undefined}>
                        {token.text}
                      </span>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && <Notice>The file is longer than this; the rest is not shown.</Notice>}
    </div>
  )
}

function Gutter({ no }: { no: number | undefined }) {
  return (
    <td className="text-muted-foreground/70 w-10 min-w-10 border-r px-2 text-right align-top select-none">
      {no ?? ""}
    </td>
  )
}

function Badge({ tone, children }: { tone: "add" | "del" | "conflict"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-px text-[0.65rem] font-medium uppercase tracking-wide",
        tone === "add" && "bg-[color-mix(in_oklch,var(--ucch-note-green)_25%,transparent)]",
        tone === "del" && "bg-[color-mix(in_oklch,var(--ucch-note-red)_25%,transparent)]",
        tone === "conflict" && "bg-[color-mix(in_oklch,var(--ucch-note-orange)_30%,transparent)]",
      )}
    >
      {children}
    </span>
  )
}

export function Notice({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground px-4 py-6 text-center text-sm">{children}</p>
}

/** What the main pane shows with nothing selected. */
export function EmptyPane({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm">
      <FileIcon className="size-8 opacity-40" />
      <p>{title}</p>
      {hint && <p className="text-xs">{hint}</p>}
    </div>
  )
}
