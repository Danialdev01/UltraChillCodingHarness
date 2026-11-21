/**
 * File references in model prose.
 *
 * Every harness is told to cite files as `[agent.ts:42](apps/server/src/agent.ts:42)`:
 * a path relative to the project root, and a line (`UCCH_WORKING_RULES` in
 * `@ucch/protocol`). The chat opens such a link in UCCH's file viewer at that
 * line rather than as a URL, which it is not.
 */

/** Extensions that name a file rather than a property: `console.log` is code. */
const FILE_EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs json jsonc md mdx css scss sass less html htm vue svelte astro py rb go rs java kt " +
    "swift c h cpp hpp cc cs php sh bash zsh fish sql prisma graphql gql yml yaml toml ini env lock txt " +
    "xml svg png jpg jpeg gif webp ico pdf csv dockerfile conf cfg example local sample"
  ).split(" "),
)

/**
 * `src/brand.ts`, `index.css`, `.env.example`: one token with no spaces, a
 * name with a letter in it, and an extension files actually have -- so
 * `1.5`, `e.g.`, `a.b()` and `console.log` stay plain code.
 */
export function looksLikeFilePath(text: string): boolean {
  if (text.length > 120 || /\s|:\/\//.test(text)) return false
  if (!/^(?:[\w@.-]+\/)*[\w@.-]*[A-Za-z][\w@-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(text)) return false
  return FILE_EXTENSIONS.has(text.slice(text.lastIndexOf(".") + 1).toLowerCase())
}

/** A file in the project, and the line to open it at (null: the top). */
export interface FileHref {
  path: string
  line: number | null
}

/**
 * The file a link's target names, or null when it is anything else: a URL,
 * an absolute path, a path out of the project (`..`), or one with a query or
 * an anchor. `./` in front and a column after the line are allowed.
 */
export function parseFileHref(href: string | null | undefined): FileHref | null {
  if (!href || href.length > 300) return null
  if (/^[/\\]|[?#\\]|:\/\//.test(href)) return null
  const match = /^(?:\.\/)?(.+?)(?::(\d{1,7})(?::\d{1,7})?)?$/.exec(href)
  if (!match) return null
  const path = match[1]!
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null
  if (!looksLikeFilePath(path)) return null
  const line = match[2] ? Number(match[2]) : null
  return { path, line: line && line > 0 ? line : null }
}
