"use client";

import * as React from "react";
import { AlertCircleIcon, DownloadIcon, FileIcon, Loader2Icon } from "lucide-react";
import { extensionOf } from "@ucch/protocol";

import { ImageViewer } from "@/components/image-viewer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes, previewKindOf } from "@/lib/attachments";
import { fetchUploadText, uploadContentUrl, type UploadText } from "@/lib/uploads-api";

/**
 * What the dialog needs to know about the thing it is showing.
 *
 * Satisfied by both shapes a chat carries: the composer's `Attachment`, which
 * has an upload id once it has been staged, and the `MessageAttachment` the
 * log records. Neither is named here, so this does not depend on which side of
 * the send it is being opened from.
 */
export interface PreviewableAttachment {
  name: string;
  size: number;
  type: string;
  /** Null when the upload never landed, and then there is nothing to show. */
  uploadId: string | null;
}

/**
 * An attachment, looked at.
 *
 * The preview is picked from the extension rather than from the type the
 * uploader claimed, because that is what the server will serve the bytes under
 * -- offering a preview the bytes would be refused for is worse than offering
 * none. Three mechanisms, each the safe one for its kind:
 *
 * An image goes in an `<img>`, which never runs script, so an SVG is a picture
 * and nothing else. A PDF goes in an empty-`sandbox` `<iframe>`, so the
 * browser's viewer works and an embedded script does not. Text is fetched as a
 * string and put in a `<pre>` -- never served as a document, which is why a
 * `.html` attachment is as safe to read as a `.txt`.
 *
 * Everything else has no preview, and says so next to the download, which is
 * always offered: that is the one thing that works for every attachment.
 */
export function AttachmentPreviewDialog({
  hash,
  attachment,
  onClose,
}: {
  hash: string;
  /** The attachment to show, or null when the dialog is closed. */
  attachment: PreviewableAttachment | null;
  onClose: () => void;
}) {
  const open = attachment !== null && attachment.uploadId !== null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{attachment?.name ?? "Attachment"}</DialogTitle>
          <DialogDescription>
            {attachment ? `${attachment.type || "file"} · ${formatBytes(attachment.size)}` : ""}
          </DialogDescription>
        </DialogHeader>

        {/* Keyed on the upload, so opening a second attachment starts its
            preview from scratch rather than showing the last one's state. */}
        {attachment?.uploadId && (
          <PreviewBody key={attachment.uploadId} hash={hash} attachment={attachment} />
        )}

        <div className="flex justify-end">
          {attachment?.uploadId && (
            <DownloadButton hash={hash} uploadId={attachment.uploadId} name={attachment.name} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The download, as a link rather than a fetch.
 *
 * An `<a download>` hands the save to the browser, which is what makes the
 * file land in the downloads folder with a progress indicator instead of
 * being buffered into memory by this page first. `download` carries the name
 * for a same-origin response; the server sends it in `Content-Disposition`
 * too, so the saved file is named correctly either way.
 */
export function DownloadButton({
  hash,
  uploadId,
  name,
  variant = "outline",
}: {
  hash: string;
  uploadId: string;
  name: string;
  variant?: "outline" | "ghost";
}) {
  return (
    <Button
      variant={variant}
      size="sm"
      nativeButton={false}
      render={
        <a href={uploadContentUrl(hash, uploadId, { download: true })} download={name} />
      }
    >
      <DownloadIcon />
      Download
    </Button>
  );
}

function PreviewBody({
  hash,
  attachment,
}: {
  hash: string;
  attachment: PreviewableAttachment;
}) {
  const kind = previewKindOf(attachment);
  const source = uploadContentUrl(hash, attachment.uploadId!);
  const [state, setState] = React.useState<"loading" | "ready" | "failed">("loading");

  if (!kind) {
    return (
      <Frame>
        <div className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm">
          <FileIcon className="size-5" />
          <p>There is no preview for this kind of file.</p>
          <p className="text-xs">Download it to open it in something that can.</p>
        </div>
      </Frame>
    );
  }

  if (kind === "text") return <TextPreview hash={hash} uploadId={attachment.uploadId!} />;

  return (
    <Frame>
      {state === "loading" && (
        <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-xs">
          <Loader2Icon className="size-3.5 animate-spin" />
          Loading…
        </div>
      )}

      {state === "failed" ? (
        <Gone kind={kind} />
      ) : kind === "image" ? (
        <ImageViewer
          src={source}
          alt={attachment.name}
          // SVG is drawn from vectors: it stays sharp at any zoom, and the
          // pixelation the viewer applies to a magnified bitmap would be wrong.
          raster={extensionOf(attachment.name) !== "svg"}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
        />
      ) : (
        <iframe
          src={source}
          title={attachment.name}
          onLoad={() => setState("ready")}
          onError={() => setState("failed")}
          // Empty `sandbox`: no scripts, no forms, no navigation, and an opaque
          // origin. The built-in PDF viewer works inside it; a PDF carrying
          // JavaScript does not.
          sandbox=""
          className="h-full w-full border-0 bg-white"
        />
      )}
    </Frame>
  );
}

/** A text attachment, as a string in an element rather than as a document. */
function TextPreview({ hash, uploadId }: { hash: string; uploadId: string }) {
  const [content, setContent] = React.useState<UploadText | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetchUploadText(hash, uploadId)
      .then((read) => !cancelled && setContent(read))
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [hash, uploadId]);

  if (error) {
    return (
      <Frame>
        <div className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm">
          <AlertCircleIcon className="text-destructive size-5" />
          <p>{error}</p>
        </div>
      </Frame>
    );
  }

  if (!content) {
    return (
      <Frame>
        <div className="text-muted-foreground flex items-center justify-center gap-2 p-8 text-xs">
          <Loader2Icon className="size-3.5 animate-spin" />
          Reading…
        </div>
      </Frame>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Frame>
        {/* `overflow-auto` on the frame and no wrapping inside it: code is
            read in the lines it was written in, and a soft-wrapped diff or
            log is harder to read than a scrolled one. */}
        <pre className="h-full overflow-auto p-3 font-mono text-xs leading-relaxed">
          {content.text}
        </pre>
      </Frame>
      {content.truncated && (
        <p className="text-muted-foreground text-xs">
          Showing the first part of this file. Download it to read the rest.
        </p>
      )}
    </div>
  );
}

/**
 * An attachment whose bytes are no longer there.
 *
 * Staging expires, and placing a file into the project consumes its staged
 * copy -- so an attachment from an old conversation having gone is ordinary,
 * and worth saying plainly rather than leaving as a broken image.
 */
function Gone({ kind }: { kind: "image" | "pdf" }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm">
      <AlertCircleIcon className="text-destructive size-5" />
      <p>This attachment could not be shown.</p>
      <p className="text-xs">
        It may no longer be staged — attachments expire, and placing one in the project moves it —
        or it may not be a valid {kind === "pdf" ? "PDF" : "image"}.
      </p>
    </div>
  );
}

/** The fixed-height box every preview is drawn in, so the dialog never jumps. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted/30 relative flex h-[min(60vh,32rem)] items-center justify-center overflow-hidden rounded-lg border">
      {children}
    </div>
  );
}
