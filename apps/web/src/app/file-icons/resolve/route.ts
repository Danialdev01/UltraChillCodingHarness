import type { NextRequest } from "next/server"

import { iconNameFor, type IconKind } from "@/lib/file-icons"

import { KINDS, loadManifest } from "@/lib/file-icons-server"

/**
 * `GET /file-icons/resolve?q=file:README.md,folder:src` -- which icon each
 * name gets, as `{ "file:README.md": "markdown", … }`.
 *
 * A tree asks once for every name on screen, then loads each *icon* once
 * from `/file-icons/svg/{id}.svg`. A hundred files that share ten icons are
 * one request and ten images, not a hundred: the per-name URL of the plain
 * route cached by name, so `a.ts` and `b.ts` were two downloads of one
 * picture. Cached a day, like that route: answers change only with the
 * icon package.
 */
const MAX = 500

export async function GET(request: NextRequest): Promise<Response> {
  const query = request.nextUrl.searchParams.get("q") ?? ""
  const icons = await loadManifest()
  const answer: Record<string, string> = {}
  for (const item of query.split(",").slice(0, MAX)) {
    const at = item.indexOf(":")
    if (at < 0) continue
    const kind = item.slice(0, at) as IconKind
    if (!KINDS.has(kind)) continue
    let name: string
    try {
      name = decodeURIComponent(item.slice(at + 1))
    } catch {
      continue
    }
    answer[item] = iconNameFor(icons, kind, name)
  }
  return Response.json(answer, {
    headers: { "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
  })
}
