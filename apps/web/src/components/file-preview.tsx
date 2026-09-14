"use client"

import * as React from "react"
import { AlertCircleIcon, FileTextIcon, ImageIcon, Loader2Icon } from "lucide-react"
import { extensionOf, previewKindFor } from "@ucch/protocol"

import { ImageViewer } from "@/components/image-viewer"
import { basename, rawFileUrl } from "@/lib/files-api"

/**
 * An image or a PDF, where the text editor would otherwise be.
 *
 * The bytes come from `/file/raw`, which serves them under a type derived
 * from the extension and behind a CSP that sandboxes the response. The
 * element each kind lands in is the second half of that:
 *
 * An image goes in an `<img>`, never inline and never in an iframe. That
 * matters most for SVG, which is a document that can carry script: an `<img>`
 * does not run it, whatever the file contains, so the preview is a picture
 * and nothing more.
 *
 * A PDF goes in a sandboxed `<iframe>` -- the browser's own viewer, which is
 * the only sensible way to page through one, with `sandbox` keeping it out of
 * this origin.
 */
export function FilePreview({ hash, path }: { hash: string; path: string }) {
  const kind = previewKindFor(path)
  const source = rawFileUrl(hash, path)

  // Reset per file: switching tabs reuses this component, and a spinner or an
  // error left over from the previous file would describe the wrong one.
  const [state, setState] = React.useState<"loading" | "ready" | "failed">("loading")
  React.useEffect(() => setState("loading"), [source])

  if (!kind) return null

  return (
    <div className="bg-muted/30 relative flex min-h-0 flex-1 flex-col">
      {state === "loading" && (
        <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-xs">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading {basename(path)}…
        </div>
      )}

      {state === "failed" ? (
        <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-sm">
          <AlertCircleIcon className="text-destructive size-5" />
          <p>{basename(path)} could not be displayed.</p>
          <p className="text-xs">
            It may be too large to preview, or not a valid {kind === "pdf" ? "PDF" : "image"}.
          </p>
        </div>
      ) : kind === "image" ? (
        <ImageViewer
          src={source}
          alt={basename(path)}
          // SVG is drawn from vectors: it stays sharp at any zoom, and the
          // pixelation the viewer applies to a magnified bitmap would be
          // wrong for it.
          raster={extensionOf(path) !== "svg"}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      ) : (
        <iframe
          src={source}
          title={basename(path)}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
          // Empty `sandbox`: no scripts, no forms, no navigation, and an
          // opaque origin. The built-in PDF viewer works inside it; a PDF
          // with embedded JavaScript does not.
          sandbox=""
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  )
}

/** The icon for a previewable file, for the tab bar. */
export function previewIcon(path: string) {
  return previewKindFor(path) === "pdf" ? FileTextIcon : ImageIcon
}
