import { readFile } from "node:fs/promises"
import path from "node:path"
import type { NextRequest } from "next/server"

import { ICON_NAME, iconNameFor, type IconKind } from "@/lib/file-icons"
import { findPackageDir, KINDS, loadManifest } from "@/lib/file-icons-server"

/**
 * `GET /file-icons?kind=file&name=README.md` -- the Material icon for a path.
 * `kind=icon&name=next` asks for an icon by its id instead.
 *
 * Served from the `material-icon-theme` package in node_modules, which is
 * the VS Code extension's own SVGs and lookup tables. The tree asks by name
 * and kind rather than by icon, so the browser caches one URL per distinct
 * file name and the 450KB manifest never leaves the server.
 *
 * Served, not redirected: a redirect per row would double the requests for
 * a tree of a hundred files. Cached for a day, since an icon for a name only
 * changes when the package does.
 */

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams
  const kind = params.get("kind") ?? "file"
  const name = params.get("name") ?? ""
  // An empty name is allowed: it resolves to the default of its kind, which
  // is what a row that has no name yet shows.
  if (!KINDS.has(kind as IconKind)) return new Response("unknown kind", { status: 400 })

  const icons = await loadManifest()
  const iconName = iconNameFor(icons, kind as IconKind, name)
  // The manifest is trusted, but the id still gates the path it is joined
  // into: nothing from the request reaches the filesystem.
  const definition = icons.iconDefinitions[iconName]
  if (!definition || !ICON_NAME.test(iconName)) return new Response("no icon", { status: 404 })

  const file = path.join(await findPackageDir(), "icons", `${iconName}.svg`)
  const svg = await readFile(file).catch(() => null)
  if (!svg) return new Response("no icon", { status: 404 })

  return new Response(svg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400, stale-while-revalidate=604800",
      // Which icon it resolved to, for anyone debugging a surprising one.
      "x-icon": iconName,
    },
  })
}
