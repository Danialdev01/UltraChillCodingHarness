/** Resolve local image references through the session-scoped, authenticated file route. */
import { rawFileUrl } from "./files-api"
import type { ProjectTarget } from "./project-target"

export function chatImageSource(src: string, target?: ProjectTarget): { src: string; path: string | null } {
  if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/i.test(src)) return { src, path: null }
  let path: string
  try { path = decodeURIComponent(src).replace(/^\.\//, "") } catch { return { src: "", path: null } }
  if (!path || path.split(/[\\/]/).some((part) => part === "..") || !/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(path)) {
    return { src: "", path: null }
  }
  return { src: rawFileUrl(target, path), path }
}
