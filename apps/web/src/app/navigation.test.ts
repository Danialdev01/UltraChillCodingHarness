/**
 * Page changes paint at once. This keeps the three things that make that
 * true from being forgotten on the next page someone adds:
 *
 * 1. Every route has a `loading.tsx` at or above it. The router prefetches a
 *    dynamic route only down to its first loading boundary, so without one a
 *    click waits on the server with the old page frozen under the view
 *    transition. With one, the skeleton is already in the browser.
 * 2. Navigation goes through `TransitionLink` / `useTransitionRouter`
 *    (`src/lib/view-transitions.tsx`), never `next/link` or a bare
 *    `useRouter().push`.
 * 3. Data on its way shows a skeleton (`src/components/page-skeletons.tsx`),
 *    not "Loading…" text.
 *
 * See `apps/web/CLAUDE.md`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const APP = fileURLToPath(new URL(".", import.meta.url))
const SRC = fileURLToPath(new URL("..", import.meta.url))

function walk(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(dir, entry.name), keep)
      : keep(entry.name)
        ? [join(dir, entry.name)]
        : [],
  )
}

/** Route trees whose pages must have a loading boundary, as paths under `src/app`. */
const ROOTS = ["(app)", "shared"]

/** Pages outside those trees, each with why it needs no boundary. */
const OUTSIDE: Record<string, string> = {
  "login/page.tsx": "static, so prefetched whole",
  "dev/themes/page.tsx": "a developer's swatch page, not part of the app",
}

describe("loading boundaries", () => {
  const pages = walk(APP, (name) => name === "page.tsx").map((path) => relative(APP, path).split(sep).join("/"))

  it("finds the pages", () => {
    expect(pages.length).toBeGreaterThan(10)
  })

  it("every page sits in a known route tree", () => {
    const stray = pages.filter((page) => !ROOTS.some((root) => page.startsWith(`${root}/`)) && !(page in OUTSIDE))
    expect(stray, "add a loading.tsx-backed route under (app)/ or shared/, or list it in OUTSIDE with a reason").toEqual(
      [],
    )
  })

  it("every page under (app)/ and shared/ has a loading.tsx at or above it", () => {
    const missing = pages
      .filter((page) => ROOTS.some((root) => page.startsWith(`${root}/`)))
      .filter((page) => {
        const root = join(APP, page.split("/")[0]!)
        // The root itself does not count: a boundary there would wrap every
        // page in the tree in one skeleton.
        for (let dir = dirname(join(APP, page)); dir !== root; dir = dirname(dir)) {
          if (existsSync(join(dir, "loading.tsx"))) return false
        }
        return true
      })
    expect(missing, "add a loading.tsx that renders the page's skeleton from page-skeletons.tsx").toEqual([])
  })
})

const sources = walk(join(SRC, "components"), (name) => /\.tsx?$/.test(name) && !name.includes(".test."))
  .concat(walk(join(SRC, "lib"), (name) => /\.tsx?$/.test(name) && !name.includes(".test.")))
  .map((path) => ({ path: relative(SRC, path).split(sep).join("/"), text: readFileSync(path, "utf8") }))

describe("navigation goes through view transitions", () => {
  it("never imports next/link", () => {
    const hits = sources
      .filter(({ path }) => path !== "lib/view-transitions.tsx")
      .filter(({ text }) => /from ["']next\/link["']/.test(text))
      .map(({ path }) => path)
    expect(hits, "use TransitionLink from @/lib/view-transitions").toEqual([])
  })

  /** Files that navigate with `next/navigation`'s router on purpose, and why. */
  const ROUTER_ALLOWED: Record<string, string> = {
    "lib/view-transitions.tsx": "the wrapper itself",
    "components/database/use-tab.ts": "rewrites the current page's ?tab= in place; not a page change",
  }

  it("never pushes with next/navigation's useRouter", () => {
    const hits = sources
      .filter(({ path }) => !(path in ROUTER_ALLOWED))
      .filter(({ text }) => /\buseRouter\b[^\n]*from ["']next\/navigation["']/.test(text))
      .filter(({ text }) => /\brouter\.(push|replace|back|forward)\(/.test(text))
      .map(({ path }) => path)
    expect(hits, "use useTransitionRouter from @/lib/view-transitions (refresh() is fine on the plain router)").toEqual(
      [],
    )
  })
})

describe("loading states are skeletons", () => {
  /** Lines allowed to say "Loading", with why. */
  const ALLOWED: Array<[file: string, fragment: string]> = [
    // A button that fetches the next page on request: an action in flight.
    ["components/public/public-timeline.tsx", '{loading ? "Loading…" : "Show older"}'],
  ]

  it('no "Loading…" text in components', () => {
    const hits: string[] = []
    for (const { path, text } of sources) {
      if (!path.startsWith("components/")) continue
      text.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
        if (!/(Loading|Reading)(…|\.\.\.)/.test(line)) return
        if (ALLOWED.some(([file, fragment]) => file === path && line.includes(fragment))) return
        hits.push(`${path}:${i + 1}`)
      })
    }
    expect(hits, "render a skeleton from page-skeletons.tsx (or ui/skeleton) in the shape of what is coming").toEqual(
      [],
    )
  })
})
