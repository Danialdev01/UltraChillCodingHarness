"use client"

import * as React from "react"
import {
  CaseSensitiveIcon,
  ChevronRightIcon,
  Loader2Icon,
  RegexIcon,
  ReplaceAllIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { useFilesPanel } from "@/components/files-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { targetOf } from "@/lib/project-target"
import {
  allKeys,
  groupByFile,
  highlight,
  matchKey,
  previewSegments,
  replaceInFiles,
  searchFiles,
  selectionBody,
  type ReplaceResult,
  type SearchMatch,
  type SearchResult,
} from "@/lib/search-api"

/** How long to wait after a keystroke before searching. */
const DEBOUNCE_MS = 250

/**
 * Searching every file in the project, in the sidebar.
 *
 * ripgrep on the server, one search per quarter-second of quiet, and the last
 * one aborted when the next starts -- so typing a word does not queue six
 * searches whose answers arrive in whatever order they finish in.
 *
 * A result is a line, and clicking it opens that file at that line. That is the
 * whole point of the panel: "where is this" is only half an answer if getting
 * there is still a manual scroll.
 *
 * Literal text by default rather than a regular expression, because what people
 * type is keywords -- `config.get(` is four metacharacters and nobody meant any
 * of them. The toggles are there for when you did mean them.
 *
 * Replace is folded away under the chevron until it is wanted. Opened, every
 * match gets a tick box, all ticked to begin with, and each line previews what
 * it will read afterwards. Nothing is written until the dialog is confirmed,
 * and then only the ticked matches -- which the server checks against the
 * files as they are by then.
 */
export function SearchPanel() {
  const { project, closeSearch, revealInFile, activeTab } = useFilesPanel()
  // The tree searched and written: the session's worktree when there is one.
  const hash = project?.hash ?? null
  const sessionHash = project?.sessionHash ?? null
  const target = React.useMemo(() => (hash ? targetOf({ hash, sessionHash }) : null), [hash, sessionHash])

  const [query, setQuery] = React.useState("")
  const [caseSensitive, setCaseSensitive] = React.useState(false)
  const [regex, setRegex] = React.useState(false)
  const [result, setResult] = React.useState<SearchResult | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [replaceOpen, setReplaceOpen] = React.useState(false)
  const [replacement, setReplacement] = React.useState("")
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [confirming, setConfirming] = React.useState(false)
  const [done, setDone] = React.useState<ReplaceResult | null>(null)
  // Bumped after a replace, to search again and show what is left.
  const [rerun, setRerun] = React.useState(0)

  React.useEffect(() => {
    const trimmed = query.trim()
    setError(null)
    if (!target || !trimmed) {
      setResult(null)
      setSearching(false)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      setSearching(true)
      void searchFiles(target, trimmed, {
        caseSensitive,
        regex,
        signal: controller.signal,
      })
        .then(setResult)
        .catch((e: unknown) => {
          // An abort is this effect superseding itself, not a failure to report.
          if (controller.signal.aborted) return
          setResult(null)
          setError(e instanceof Error ? e.message : String(e))
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [target, query, caseSensitive, regex, rerun])

  // New results start with every match ticked.
  React.useEffect(() => setSelected(allKeys(result?.matches ?? [])), [result])
  // A different search makes the last replace's summary about something else.
  React.useEffect(() => setDone(null), [query, caseSensitive, regex])

  const groups = React.useMemo(() => groupByFile(result?.matches ?? []), [result])
  const total = result?.matches.length ?? 0
  const occurrences = React.useMemo(() => allKeys(result?.matches ?? []).size, [result])
  const ticked = React.useMemo(() => selectionBody(groups, selected), [groups, selected])
  const tickedCount = ticked.reduce((sum, file) => sum + file.matches.length, 0)

  function setTicked(keys: string[], on: boolean) {
    setSelected((current) => {
      const next = new Set(current)
      for (const key of keys) {
        if (on) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }

  async function replace() {
    if (!target) return
    const outcome = await replaceInFiles(target, {
      query: query.trim(),
      caseSensitive,
      regex,
      replacement,
      files: ticked,
    })
    setDone(outcome)
    setRerun((n) => n + 1)
  }

  return (
    <>
      {/* h-10 matches the tree's header and the editor's tab strip, so the
          three line up across the page. */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-4">
        <SearchIcon className="size-4 shrink-0" />
        <span className="flex-1 truncate text-sm font-medium">Search</span>
        <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={closeSearch}>
          <XIcon />
          <span className="sr-only">Close search</span>
        </Button>
      </div>

      <div className="flex shrink-0 flex-col gap-1.5 border-b p-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-expanded={replaceOpen}
            onClick={() => setReplaceOpen((open) => !open)}
            title={replaceOpen ? "Hide replace" : "Replace"}
            className="text-muted-foreground hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-md"
          >
            <ChevronRightIcon className={cn("size-3.5 transition-transform", replaceOpen && "rotate-90")} />
            <span className="sr-only">{replaceOpen ? "Hide replace" : "Show replace"}</span>
          </button>
          <div className="border-input bg-background focus-within:ring-ring flex min-w-0 flex-1 items-center rounded-md border focus-within:ring-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search all files…"
              spellCheck={false}
              autoComplete="off"
              // autoFocus: the panel is opened in order to type in it.
              autoFocus
              maxLength={200}
              aria-label="Search all files"
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent px-2 py-1.5 text-sm outline-none"
            />
            {searching ? (
              <Loader2Icon className="text-muted-foreground mr-1.5 size-3.5 shrink-0 animate-spin" />
            ) : (
              query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  title="Clear"
                  className="text-muted-foreground hover:text-foreground mr-1 shrink-0 rounded-sm p-1"
                >
                  <XIcon className="size-3" />
                  <span className="sr-only">Clear the search</span>
                </button>
              )
            )}
          </div>
        </div>

        {replaceOpen && (
          <div className="flex items-center gap-1 pl-7">
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="Replace with…"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              aria-label="Replace with"
              className="border-input bg-background focus:ring-ring placeholder:text-muted-foreground min-w-0 flex-1 rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              disabled={tickedCount === 0 || searching || !query.trim()}
              onClick={() => setConfirming(true)}
              title={`Replace ${tickedCount} selected`}
            >
              <ReplaceAllIcon />
              <span className="sr-only">Replace {tickedCount} selected</span>
            </Button>
          </div>
        )}

        <div className="flex items-center gap-1">
          <Flag
            label="Match case"
            pressed={caseSensitive}
            onToggle={() => setCaseSensitive((on) => !on)}
            icon={CaseSensitiveIcon}
          />
          <Flag label="Regular expression" pressed={regex} onToggle={() => setRegex((on) => !on)} icon={RegexIcon} />
          {replaceOpen && occurrences > 0 && (
            <button
              type="button"
              onClick={() => setSelected(tickedCount === occurrences ? new Set() : allKeys(result?.matches ?? []))}
              className="text-muted-foreground hover:text-foreground rounded-md px-1 text-xs"
            >
              {tickedCount === occurrences ? "Select none" : "Select all"}
            </button>
          )}
          <span className="text-muted-foreground ml-auto truncate px-1 text-xs">
            {error
              ? ""
              : total > 0
                ? replaceOpen
                  ? `${tickedCount} of ${occurrences} selected`
                  : `${total}${result?.truncated ? "+" : ""} in ${groups.length} file${groups.length === 1 ? "" : "s"}`
                : ""}
          </span>
        </div>

        {done && (
          <p role="status" className="text-muted-foreground px-1 text-xs">
            Replaced {done.replaced} in {plural(done.files, "file")}
            {done.skipped.length > 0 && (
              <span title={done.skipped.map((s) => `${s.path}: ${s.reason}`).join("\n")}>
                {" "}
                · {plural(done.skipped.length, "file")} not fully replaced (changed since the search)
              </span>
            )}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Replace ${plural(tickedCount, "occurrence")} in ${plural(ticked.length, "file")}?`}
        description={
          <>
            <span className="font-mono">{query.trim()}</span> becomes{" "}
            {replacement ? <span className="font-mono">{replacement}</span> : "nothing (deleted)"}. The files are
            written straight away.
          </>
        }
        confirmLabel="Replace"
        onConfirm={replace}
      >
        <ul className="max-h-48 overflow-auto rounded-md border p-2 text-xs">
          {ticked.map((file) => (
            <li key={file.path} className="flex gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate font-mono" title={file.path}>
                {file.path}
              </span>
              <span className="text-muted-foreground shrink-0">{file.matches.length}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      <div className="min-h-0 flex-1 overflow-auto p-1">
        {error ? (
          <p role="alert" className="text-destructive px-2 py-2 text-xs">
            {error}
          </p>
        ) : !query.trim() ? (
          <p className="text-muted-foreground px-2 py-2 text-xs">
            Type to search every file in the working directory. Files ignored by git are skipped.
          </p>
        ) : total === 0 && !searching ? (
          <p className="text-muted-foreground px-2 py-2 text-xs">No matches.</p>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.path} className="mb-2">
                <div className="flex items-center">
                  {replaceOpen && (
                    <Tick
                      keys={keysOf(group.matches)}
                      selected={selected}
                      onChange={setTicked}
                      label={`Replace in ${group.path}`}
                    />
                  )}
                  {/* The path, with its own filename picked out: the directory is
                      context and the filename is what you are looking for. */}
                  <p
                    title={group.path}
                    className={cn(
                      "min-w-0 flex-1 truncate px-2 py-1 text-xs",
                      group.path === activeTab ? "text-ucch-active" : "text-muted-foreground",
                    )}
                  >
                    <span>{directoryOf(group.path)}</span>
                    <span className="font-medium">{filenameOf(group.path)}</span>
                  </p>
                </div>

                {group.matches.map((match, i) => (
                  <div key={`${match.line}-${i}`} className="flex items-center">
                    {replaceOpen && (
                      <Tick
                        keys={keysOf([match])}
                        selected={selected}
                        onChange={setTicked}
                        label={`Replace on line ${match.line}`}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => revealInFile(match.path, match.line)}
                      title={`${match.path}:${match.line}`}
                      className="hover:bg-sidebar-accent flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-2 py-0.5 text-left"
                    >
                      <span className="text-muted-foreground w-8 shrink-0 text-right font-mono text-[10px]">
                        {match.line}
                      </span>
                      {/* `truncate` rather than wrapping: one row per match keeps
                        a hundred results scannable, and the whole line is in
                        the editor a click away. */}
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {replaceOpen
                          ? previewSegments(
                              match.text,
                              match.ranges,
                              (start) => selected.has(matchKey(match.path, match.line, start)),
                              replacement,
                            ).map((segment, at) => (
                              <span key={at} className={PREVIEW_CLASS[segment.kind]}>
                                {segment.text}
                              </span>
                            ))
                          : highlight(match.text, match.ranges).map((segment, at) => (
                              <span
                                key={at}
                                className={segment.match ? "bg-ucch-active-bg text-ucch-active rounded-sm" : undefined}
                              >
                                {segment.text}
                              </span>
                            ))}
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            ))}

            {result?.truncated && (
              <p className="text-muted-foreground px-2 py-2 text-xs">
                Only the first {total} matches are listed. Narrow the search to see the rest.
              </p>
            )}
          </>
        )}
      </div>
    </>
  )
}

/** How each part of a replace preview is drawn. */
const PREVIEW_CLASS = {
  text: undefined,
  match: "bg-ucch-active-bg text-ucch-active rounded-sm",
  removed: "bg-diff-del-word line-through rounded-sm",
  inserted: "bg-diff-add-word rounded-sm",
} as const

/**
 * A tick box over some matches: one, or a whole file's. Mixed when only some
 * of a file's are ticked, and ticking it then ticks them all.
 */
function Tick({
  keys,
  selected,
  onChange,
  label,
}: {
  keys: string[]
  selected: ReadonlySet<string>
  onChange: (keys: string[], on: boolean) => void
  label: string
}) {
  const count = keys.filter((key) => selected.has(key)).length
  const all = keys.length > 0 && count === keys.length
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && !all
  }, [count, all])

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      onChange={() => onChange(keys, !all)}
      aria-label={label}
      title={label}
      className="accent-primary ml-1 size-3.5 shrink-0"
    />
  )
}

/** The tick-box keys of some matches: one per occurrence. */
function keysOf(matches: readonly SearchMatch[]): string[] {
  return matches.flatMap((match) => match.ranges.map(([start]) => matchKey(match.path, match.line, start)))
}

/** "1 file", "3 files". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

/** One of the search's two switches. */
function Flag({
  label,
  pressed,
  onToggle,
  icon: Icon,
}: {
  label: string
  pressed: boolean
  onToggle: () => void
  icon: typeof SearchIcon
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      title={label}
      className={cn(
        "text-muted-foreground hover:text-foreground flex size-6 items-center justify-center rounded-md transition-colors",
        "aria-pressed:bg-ucch-active-bg aria-pressed:text-ucch-active",
      )}
    >
      <Icon className="size-3.5" />
      <span className="sr-only">{label}</span>
    </button>
  )
}

/** "app/lib/thing.ts" -> "app/lib/" */
function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/")
  return cut === -1 ? "" : path.slice(0, cut + 1)
}

/** "app/lib/thing.ts" -> "thing.ts" */
function filenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1)
}
