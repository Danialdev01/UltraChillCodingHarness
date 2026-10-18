import { readFile } from "node:fs/promises"
import path from "node:path"

import { ICON_NAME } from "@/lib/file-icons"

import { findPackageDir, loadManifest } from "@/lib/file-icons-server"

/**
 * `GET /file-icons/svg/{id}.svg` -- one Material icon by its id, cached for
 * a year: the URL carries the icon package's version (`?v=`), so an upgrade
 * is a new address rather than a stale picture.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const id = (await params).id.replace(/\.svg$/, "")
  const icons = await loadManifest()
  // Only ids the manifest defines, and only ones shaped like an id: nothing
  // from the request reaches the filesystem otherwise.
  if (!ICON_NAME.test(id) || !icons.iconDefinitions[id]) return new Response("no icon", { status: 404 })
  const svg = await readFile(path.join(await findPackageDir(), "icons", `${id}.svg`)).catch(() => null)
  if (!svg) return new Response("no icon", { status: 404 })
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable" },
  })
}
