"use client"

import * as React from "react"
import { CaseSensitiveIcon, Loader2Icon, RegexIcon, SearchIcon, XIcon } from "lucide-react"

import { useFilesPanel } from "@/components/files-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { groupByFile, highlight, searchFiles, type SearchResult } from "@/lib/search-api"

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
 */
export function SearchPanel() {
  const { project, closeSearch, revealInFile, activeTab } = useFilesPanel()
  const hash = project?.hash ?? null

  const [query, setQuery] = React.useState("")
  const [caseSensitive, setCaseSensitive] = React.useState(false)
  const [regex, setRegex] = React.useState(false)
  const [result, setResult] = React.useState<SearchResult | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    const trimmed = query.trim()
    setError(null)
    if (!hash || !trimmed) {
      setResult(null)
      setSearching(false)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      setSearching(true)
      void searchFiles(hash, trimmed, {
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
  }, [hash, query, caseSensitive, regex])

  const groups = React.useMemo(() => groupByFile(result?.matches ?? []), [result])
  const total = result?.matches.length ?? 0

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
        <div className="border-input bg-background focus-within:ring-ring flex items-center rounded-md border focus-within:ring-2">
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

        <div className="flex items-center gap-1">
          <Flag
            label="Match case"
            pressed={caseSensitive}
            onToggle={() => setCaseSensitive((on) => !on)}
            icon={CaseSensitiveIcon}
          />
          <Flag
            label="Regular expression"
            pressed={regex}
            onToggle={() => setRegex((on) => !on)}
            icon={RegexIcon}
          />
          <span className="text-muted-foreground ml-auto truncate px-1 text-xs">
            {error
              ? ""
              : total > 0
                ? `${total}${result?.truncated ? "+" : ""} in ${groups.length} file${groups.length === 1 ? "" : "s"}`
                : ""}
          </span>
        </div>
      </div>

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
                {/* The path, with its own filename picked out: the directory is
                    context and the filename is what you are looking for. */}
                <p
                  title={group.path}
                  className={cn(
                    "truncate px-2 py-1 text-xs",
                    group.path === activeTab ? "text-ucch-active" : "text-muted-foreground",
                  )}
                >
                  <span className="opacity-60">{directoryOf(group.path)}</span>
                  <span className="font-medium">{filenameOf(group.path)}</span>
                </p>

                {group.matches.map((match, i) => (
                  <button
                    key={`${match.line}-${i}`}
                    type="button"
                    onClick={() => revealInFile(match.path, match.line)}
                    title={`${match.path}:${match.line}`}
                    className="hover:bg-sidebar-accent flex w-full items-baseline gap-2 rounded-md px-2 py-0.5 text-left"
                  >
                    <span className="text-muted-foreground w-8 shrink-0 text-right font-mono text-[10px]">
                      {match.line}
                    </span>
                    {/* `truncate` rather than wrapping: one row per match keeps
                        a hundred results scannable, and the whole line is in
                        the editor a click away. */}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {highlight(match.text, match.ranges).map((segment, at) => (
                        <span
                          key={at}
                          className={
                            segment.match
                              ? "bg-ucch-active-bg text-ucch-active rounded-sm"
                              : undefined
                          }
                        >
                          {segment.text}
                        </span>
                      ))}
                    </span>
                  </button>
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
