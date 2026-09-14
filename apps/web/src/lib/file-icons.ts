/**
 * Which Material icon a path gets, by the rules the VS Code theme uses.
 *
 * The lookup tables are the theme's own manifest (`material-icons.json`),
 * which is far too large to ship to the browser -- so this runs on the
 * server, behind the `/file-icons` route, and the tree only asks for an
 * image by name and kind.
 */
export interface IconManifest {
  iconDefinitions: Record<string, { iconPath: string }>
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  file: string
  folder: string
  folderExpanded: string
}

export type IconKind = "file" | "folder" | "folder-open"

/**
 * The icon's name in the manifest, never undefined: the theme's defaults
 * stand in for anything it has no better answer for.
 *
 * A file is matched by its whole name first (`Dockerfile`, `package.json`),
 * then by its extension, longest first -- `test.ts` before `ts` -- which is
 * how `foo.test.ts` gets the test icon rather than the TypeScript one.
 */
export function iconNameFor(manifest: IconManifest, kind: IconKind, name: string): string {
  const lower = name.toLowerCase()

  if (kind === "folder") return manifest.folderNames[lower] ?? manifest.folder
  if (kind === "folder-open") return manifest.folderNamesExpanded[lower] ?? manifest.folderExpanded

  const byName = manifest.fileNames[lower]
  if (byName) return byName

  const parts = lower.split(".")
  // From the second segment on, so `.gitignore` looks up `gitignore` and
  // `a.b.c` tries `b.c` and then `c`.
  for (let i = 1; i < parts.length; i++) {
    const icon = manifest.fileExtensions[parts.slice(i).join(".")]
    if (icon) return icon
  }
  return manifest.file
}

/** The name is an id, not a path: anything else is refused before it reaches the disk. */
export const ICON_NAME = /^[a-z0-9][a-z0-9_-]*$/
