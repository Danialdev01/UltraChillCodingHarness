"use client"

import * as React from "react"
import { ALargeSmallIcon, ChevronDownIcon, FolderTreeIcon, MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react"

import { FileTypeIcon } from "@/components/file-type-icon"
import { Button } from "@/components/ui/button"
import { EDITOR_FONT_SIZE } from "@/lib/editor-font-size"
import type { FontSizePreference } from "@/lib/font-size-preference"
import { TREE_FONT_SIZE, treeMetrics } from "@/lib/tree-font-size"

/**
 * One font-size preference as a settings section.
 *
 * A browser preference like the keybindings, kept in `localStorage` and
 * applied at once wherever it is in force. A stepper with a field in the
 * middle: the buttons for nudging by a pixel, the field for anyone who knows
 * the number they want. The field commits on blur or Enter rather than on
 * every keystroke, so typing "16" does not pass through an 1px editor.
 *
 * Read after mount rather than during render, so the first paint matches what
 * the server produced and nothing is hydrated against a value it never had.
 */
function FontSizeSection({
  preference,
  icon: Icon,
  title,
  description,
  preview,
}: {
  preference: FontSizePreference
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: React.ReactNode
  /** Something at the chosen size, so the number means something before it is used. */
  preview: (size: number) => React.ReactNode
}) {
  const [size, setSize] = React.useState(preference.defaultSize)
  const [draft, setDraft] = React.useState(String(preference.defaultSize))

  React.useEffect(() => {
    const initial = preference.read()
    setSize(initial)
    setDraft(String(initial))
    return preference.watch((px) => {
      setSize(px)
      setDraft(String(px))
    })
  }, [preference])

  function choose(px: number) {
    const stored = preference.write(px)
    setSize(stored)
    setDraft(String(stored))
  }

  function commitDraft() {
    const parsed = preference.parse(draft)
    // Not a number: put the field back to what is in force rather than
    // leaving "abc" sitting there as though it meant something.
    if (parsed === null) setDraft(String(size))
    else choose(parsed)
  }

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Icon className="text-muted-foreground size-4" />
        {title}
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        {description} Between {preference.min} and {preference.max}. Applies to this browser only.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="bg-muted/40 inline-flex items-center rounded-lg border p-0.5">
          <button
            type="button"
            aria-label="Smaller"
            disabled={size <= preference.min}
            onClick={() => choose(size - 1)}
            className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40"
          >
            <MinusIcon className="size-3.5" />
          </button>
          <input
            type="number"
            inputMode="numeric"
            aria-label="Font size in pixels"
            min={preference.min}
            max={preference.max}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur()
            }}
            className="bg-background h-7 w-14 rounded-md text-center font-mono text-xs shadow-sm outline-hidden [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <button
            type="button"
            aria-label="Larger"
            disabled={size >= preference.max}
            onClick={() => choose(size + 1)}
            className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors disabled:opacity-40"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
        <span className="text-muted-foreground text-xs">px</span>
        {size !== preference.defaultSize && (
          <Button variant="outline" size="sm" onClick={() => choose(preference.defaultSize)}>
            <RotateCcwIcon />
            Reset to {preference.defaultSize}
          </Button>
        )}
      </div>

      {preview(size)}
    </section>
  )
}

/** The size the code editor renders at. */
export function FontSizeSettings() {
  return (
    <FontSizeSection
      preference={EDITOR_FONT_SIZE}
      icon={ALargeSmallIcon}
      title="Editor font size"
      description="How large the code editor in a project's file view renders, in pixels."
      preview={(size) => (
        // A line of code at the chosen size.
        <pre
          aria-hidden
          className="text-muted-foreground mt-4 overflow-x-auto rounded-md border px-3 py-2 font-mono"
          style={{ fontSize: `${size}px`, lineHeight: `${Math.max(24, Math.round(size * 1.5))}px` }}
        >
          {"const answer = compute(42) // preview"}
        </pre>
      )}
    />
  )
}

/** The size the file tree's rows render at: the file name and its icon. */
export function TreeFontSizeSettings() {
  return (
    <FontSizeSection
      preference={TREE_FONT_SIZE}
      icon={FolderTreeIcon}
      title="File tree sidebar font size"
      description="How large the file names and icons in a project's file tree render, in pixels."
      preview={(size) => {
        const m = treeMetrics(size)
        const icon = { width: m.iconSize, height: m.iconSize, marginRight: m.gapLabel }
        const chevron = { width: m.chevronBox, height: m.chevronBox, marginRight: m.gapChevron }
        // A folder and a file inside it, as the tree draws them at the chosen
        // size -- row height, chevron column, gaps and indent included, since
        // they follow the size too.
        const row = (depth: number) => ({
          height: m.rowHeight,
          paddingLeft: m.padX + m.indent * depth,
          paddingRight: m.padX,
        })
        return (
          <div
            aria-hidden
            className="text-muted-foreground mt-4 flex flex-col rounded-md border py-1"
            style={{ fontSize: `${size}px` }}
          >
            <div className="flex items-center" style={row(0)}>
              <span className="flex shrink-0 items-center justify-center" style={chevron}>
                <ChevronDownIcon style={{ width: m.chevronGlyph, height: m.chevronGlyph }} />
              </span>
              <FileTypeIcon name="src" kind="folder-open" style={icon} className="size-auto" />
              <span>src</span>
            </div>
            <div className="flex items-center" style={row(1)}>
              <span className="shrink-0" style={chevron} />
              <FileTypeIcon name="index.ts" style={icon} className="size-auto" />
              <span>index.ts</span>
            </div>
          </div>
        )
      }}
    />
  )
}
