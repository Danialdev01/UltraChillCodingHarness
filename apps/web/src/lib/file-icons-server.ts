import { access, readFile } from "node:fs/promises"
import path from "node:path"

import type { IconKind, IconManifest } from "./file-icons"

/** The `/file-icons` routes' shared reads of the `material-icon-theme` package. */

/**
 * Where the package is on disk.
 *
 * Not `require.resolve`: the route is bundled, and the bundler rewrites that
 * into its own module id rather than a path. Walking up from the working
 * directory finds the app's `node_modules` under `next dev` and `next start`
 * alike, and pnpm's symlink there is followed by the reads below.
 */
let packageDir: Promise<string> | null = null
export function findPackageDir(): Promise<string> {
  packageDir ??= (async () => {
    for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, "node_modules", "material-icon-theme")
      if (await access(path.join(candidate, "package.json")).then(() => true, () => false)) {
        return candidate
      }
      if (path.dirname(dir) === dir) throw new Error("material-icon-theme is not installed")
    }
  })()
  return packageDir
}

let manifest: Promise<IconManifest> | null = null
export function loadManifest(): Promise<IconManifest> {
  manifest ??= findPackageDir()
    .then((dir) => readFile(path.join(dir, "dist", "material-icons.json"), "utf8"))
    .then((text) => JSON.parse(text) as IconManifest)
  return manifest
}

export const KINDS = new Set<IconKind>(["file", "folder", "folder-open", "icon"])
