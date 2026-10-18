/**
 * The review checklist in `docs/color-and-theme.md` §8, as far as a grep can
 * hold it: components colour themselves with semantic tokens only, never fade
 * text below the ratio the engine guaranteed, and never take the focus
 * outline away without putting something in its place.
 *
 * The colour engine's seed sweep proves the tokens; this keeps the components
 * from stepping around them.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("../components", import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name))
      : entry.name.endsWith(".tsx")
        ? [join(dir, entry.name)]
        : [],
  )
}

const files = walk(ROOT).map((path) => ({
  path: relative(ROOT, path),
  lines: readFileSync(path, "utf8").split("\n"),
}))

/** A known exception: a file and a fragment of the line, with why. */
type Allow = [file: string, fragment: string]

/** `file:line` hits for a pattern, minus the allowed ones. */
function hits(pattern: RegExp, allowed: Allow[] = [], skip?: (path: string, line: string) => boolean): string[] {
  const out: string[] = []
  for (const { path, lines } of files) {
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      if (!pattern.test(line) || skip?.(path, line)) return
      if (allowed.some(([file, fragment]) => path.endsWith(file) && line.includes(fragment))) return
      out.push(`${path}:${i + 1}  ${line.trim().slice(0, 120)}`)
    })
  }
  return out
}

const PALETTE =
  "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white"

describe("components use semantic colour tokens", () => {
  it("has no Tailwind palette classes", () => {
    const pattern = new RegExp(
      `\\b(bg|text|border|ring|fill|stroke|outline|decoration|divide|from|via|to|accent|caret)-(${PALETTE})(-\\d{2,3})?(/\\d+)?\\b`,
    )
    expect(
      hits(pattern, [
        // A previewed HTML page is painted as the page itself would be, on
        // white -- not on the theme -- or its own dark text disappears.
        ["file-preview.tsx", "border-0 bg-white"],
        ["attachment-preview.tsx", "border-0 bg-white"],
      ]),
    ).toEqual([])
  })

  it("has no raw hex, rgb, hsl or oklch colours", () => {
    // In a class, a style or a string: anything the theme cannot reach.
    const pattern = /["'`(\s:[]#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch)\(/
    expect(hits(pattern)).toEqual([])
  })
})

describe("text keeps the contrast the engine gave it", () => {
  it("never puts an alpha on a text token", () => {
    // `text-muted-foreground/70` is a new colour nobody measured.
    expect(hits(/\btext-[a-z-]+\/\d+\b/)).toEqual([])
  })

  it("never fades text with opacity outside disabled and loading states", () => {
    // Opacity on an element fades every glyph in it. The muted token is the
    // faded text that passes. Skeletons are decorative and exempt.
    expect(
      hits(
        /(?<![:\w-])opacity-(10|20|25|30|40|50|60|70|75)\b/,
        [
          // Loading: the rows or the diagram are about to be replaced.
          ["browse-tab.tsx", 'data.state === "loading" && "opacity-60"'],
          ["diagram-editor.tsx", 'generating ? "opacity-50"'],
          // Disabled states, exempt from contrast (§6) and marked as such.
          ["column-form.tsx", 'disabled && "opacity-60"'],
          ["quick-actions.tsx", '"cursor-not-allowed opacity-40"'],
          // An icon at 70% of the full ink: still well past 3:1.
          ["project-chat.tsx", '<XIcon className="size-3 opacity-70" />'],
        ],
        (path, line) =>
          path.startsWith("ui/") ||
          path === "page-skeletons.tsx" ||
          // The large icon over an empty state is an illustration; the words
          // under it carry the message.
          /<\w+Icon className="size-(6|8) opacity-\d+" \/>/.test(line),
      ),
    ).toEqual([])
  })
})

describe("focus stays visible", () => {
  it("never removes the outline without a replacement", () => {
    // The replacement is on the element (`focus-visible:` ring or shadow) or
    // on the wrapper that draws the field (`focus-within:`), a line or two up.
    const out: string[] = []
    for (const { path, lines } of files) {
      if (path.startsWith("ui/")) continue
      lines.forEach((line, i) => {
        if (!/\b(focus:)?outline-none\b/.test(line)) return
        const near = lines.slice(Math.max(0, i - 12), i + 2).join("\n")
        if (/focus-visible:|focus-within:|focus:ring|\bring-\d/.test(near)) return
        // Popups move focus to themselves on open; the items inside carry the
        // highlight.
        if (/role="(menu|listbox|dialog)"|Popup|Positioner/.test(near)) return
        // The composer's wrapper draws the ring for the whole box, a long way
        // above its textarea.
        if (path === "project-chat.tsx" && line.includes("resize-none border-0 bg-transparent")) return
        out.push(`${path}:${i + 1}  ${line.trim().slice(0, 120)}`)
      })
    }
    expect(out).toEqual([])
  })
})
