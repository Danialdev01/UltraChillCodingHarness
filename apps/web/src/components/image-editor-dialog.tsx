"use client";

import * as React from "react";
import {
  AlertCircleIcon,
  CropIcon,
  Loader2Icon,
  MoveUpRightIcon,
  PencilIcon,
  Redo2Icon,
  RotateCcwIcon,
  SquareIcon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";

import type { PreviewableAttachment } from "@/components/attachment-preview";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import {
  clampRect,
  currentCrop,
  drawCropShade,
  drawOp,
  editedName,
  EMPTY_HISTORY,
  isUsableCrop,
  normalizeRect,
  outputType,
  PEN_COLORS,
  push,
  redo,
  strokeWidths,
  textSizeFor,
  toImagePoint,
  undo,
  type History,
  type Op,
  type Point,
  type Rect,
} from "@/lib/image-annotate";
import { uploadContentUrl } from "@/lib/uploads-api";
import { cn } from "@/lib/utils";

type Tool = "pen" | "arrow" | "rect" | "text" | "crop";

const TOOLS = [
  { value: "pen", label: <span className="hidden @lg:inline">Pen</span>, ariaLabel: "Pen", icon: PencilIcon },
  { value: "arrow", label: <span className="hidden @lg:inline">Arrow</span>, ariaLabel: "Arrow", icon: MoveUpRightIcon },
  { value: "rect", label: <span className="hidden @lg:inline">Box</span>, ariaLabel: "Box", icon: SquareIcon },
  { value: "text", label: <span className="hidden @lg:inline">Text</span>, ariaLabel: "Text", icon: TypeIcon },
  { value: "crop", label: <span className="hidden @lg:inline">Crop</span>, ariaLabel: "Crop", icon: CropIcon },
] as const;

/**
 * Draw on and crop an attached picture.
 *
 * The result is a new file handed to `onSave`; the original upload is never
 * touched here. Whoever opened the editor decides what the new file replaces:
 * a composer chip swaps in place, a picture from a sent message becomes a new
 * attachment, because a sent message is history and is not rewritten.
 */
export function ImageEditorDialog({
  hash,
  source,
  onClose,
  onSave,
}: {
  hash: string;
  /** The image to edit, or null when the dialog is closed. */
  source: PreviewableAttachment | null;
  onClose: () => void;
  onSave: (file: File) => void;
}) {
  const open = source !== null && source.uploadId !== null;
  // Closing is refused while a text label is being typed: Escape there means
  // "drop this label", not "throw away every edit".
  const typing = React.useRef(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        if (typing.current) return;
        onClose();
      }}
    >
      <DialogContent className="@container flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Edit {source?.name ?? "image"}</DialogTitle>
          <DialogDescription>
            Draw on the picture or crop it. Saving attaches the edited copy.
          </DialogDescription>
        </DialogHeader>
        {/* Keyed on the upload so a second image starts with a clean slate. */}
        {open && (
          <Editor
            key={source.uploadId}
            hash={hash}
            source={source}
            typing={typing}
            onCancel={onClose}
            onSave={(file) => {
              onSave(file);
              onClose();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A text label being typed, before it becomes an operation. */
interface TextDraft {
  at: Point;
  value: string;
  /** Screen pixels per image pixel when it was placed, to size the input. */
  scale: number;
}

function Editor({
  hash,
  source,
  typing,
  onCancel,
  onSave,
}: {
  hash: string;
  source: PreviewableAttachment;
  typing: React.MutableRefObject<boolean>;
  onCancel: () => void;
  onSave: (file: File) => void;
}) {
  const [image, setImage] = React.useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [history, setHistory] = React.useState<History>(EMPTY_HISTORY);
  const [tool, setTool] = React.useState<Tool>("pen");
  const [color, setColor] = React.useState<string>(PEN_COLORS[0].value);
  const [widthIndex, setWidthIndex] = React.useState<"0" | "1" | "2">("1");
  const [draft, setDraft] = React.useState<Op | null>(null);
  const [text, setText] = React.useState<TextDraft | null>(null);
  const [saving, setSaving] = React.useState(false);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const start = React.useRef<Point | null>(null);

  typing.current = text !== null;

  // Fetched as a blob rather than pointed at by `src`, so the canvas holds
  // bytes it is allowed to read back -- and so an SVG is a picture, drawn by
  // an <img>, never a document.
  React.useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    void fetch(uploadContentUrl(hash, source.uploadId!), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => !cancelled && setImage(img);
        img.onerror = () => !cancelled && setFailed(true);
        img.src = url;
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [hash, source.uploadId]);

  const width = image?.naturalWidth || 1;
  const height = image?.naturalHeight || 1;
  const full: Rect = { x: 0, y: 0, w: width, h: height };
  const crop = currentCrop(history.ops, width, height);
  // The crop tool shows the whole picture, so a crop can be redrawn larger;
  // every other tool works on what will be saved.
  const viewport = tool === "crop" ? full : crop;
  const widths = strokeWidths(width, height);
  const strokeWidth = widths[Number(widthIndex)]!;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = viewport.w;
    canvas.height = viewport.h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(image, viewport.x, viewport.y, viewport.w, viewport.h, 0, 0, viewport.w, viewport.h);
    ctx.save();
    ctx.translate(-viewport.x, -viewport.y);
    for (const op of history.ops) drawOp(ctx, op);
    if (draft && draft.kind !== "crop") drawOp(ctx, draft);
    if (tool === "crop") {
      const shown = draft?.kind === "crop" ? draft.rect : crop;
      if (shown.w < width || shown.h < height || draft) {
        drawCropShade(ctx, full, shown, Math.max(1, Math.max(width, height) / 600));
      }
    }
    ctx.restore();
    // `full`, `crop` and `viewport` are derived from the deps listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image, history, draft, tool, viewport.x, viewport.y, viewport.w, viewport.h]);

  function pointFrom(event: React.PointerEvent): Point {
    const box = event.currentTarget.getBoundingClientRect();
    return toImagePoint(event.clientX, event.clientY, box, viewport);
  }

  function commitText() {
    if (text && text.value.trim()) {
      setHistory((h) =>
        push(h, { kind: "text", at: text.at, text: text.value, color, size: textSizeFor(strokeWidth) }),
      );
    }
    setText(null);
  }

  function onPointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!image || event.button !== 0) return;
    // A click while a label is open places that label; it does not start another.
    if (text) return;
    const p = pointFrom(event);
    // A label is placed on release, not press: the press's own focus change
    // would otherwise blur the input as soon as it appeared.
    if (tool === "text") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = p;
    if (tool === "pen") setDraft({ kind: "stroke", points: [p], color, width: strokeWidth });
    else if (tool === "arrow") setDraft({ kind: "arrow", from: p, to: p, color, width: strokeWidth });
    else if (tool === "rect") setDraft({ kind: "rect", from: p, to: p, color, width: strokeWidth });
    else setDraft({ kind: "crop", rect: { x: p.x, y: p.y, w: 0, h: 0 } });
  }

  function onPointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!draft || !start.current) return;
    const p = pointFrom(event);
    setDraft((d) => {
      if (!d) return d;
      if (d.kind === "stroke") return { ...d, points: [...d.points, p] };
      if (d.kind === "arrow" || d.kind === "rect") return { ...d, to: p };
      if (d.kind === "crop") return { ...d, rect: clampRect(normalizeRect(start.current!, p), width, height) };
      return d;
    });
  }

  function onPointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (tool === "text" && image && !text && event.type === "pointerup") {
      const box = event.currentTarget.getBoundingClientRect();
      setText({ at: pointFrom(event), value: "", scale: box.width / viewport.w });
      return;
    }
    const d = draft;
    setDraft(null);
    start.current = null;
    if (!d) return;
    if (d.kind === "crop") {
      if (isUsableCrop(d.rect)) setHistory((h) => push(h, d));
      return;
    }
    if ((d.kind === "arrow" || d.kind === "rect") && Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 3) {
      return;
    }
    setHistory((h) => push(h, d));
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.target instanceof HTMLInputElement) return;
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) {
      event.preventDefault();
      setHistory(undo);
    } else if ((key === "z" && event.shiftKey) || key === "y") {
      event.preventDefault();
      setHistory(redo);
    }
  }

  async function save() {
    if (!image) return;
    setSaving(true);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = crop.w;
      canvas.height = crop.h;
      const ctx = canvas.getContext("2d")!;
      const type = outputType(source.type);
      // JPEG has no transparency; a transparent area would come out black.
      if (type === "image/jpeg") {
        ctx.fillStyle = PEN_COLORS[5].value;
        ctx.fillRect(0, 0, crop.w, crop.h);
      }
      ctx.drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      ctx.translate(-crop.x, -crop.y);
      for (const op of history.ops) drawOp(ctx, op);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
      if (!blob) throw new Error("Could not encode the image.");
      onSave(new File([blob], editedName(source.name, type), { type }));
    } catch {
      setSaving(false);
      setFailed(true);
    }
  }

  const dirty = history.ops.length > 0;

  return (
    <div className="flex min-h-0 flex-col gap-3" onKeyDown={onKeyDown}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Tool"
          options={TOOLS}
          value={tool}
          onChange={(next) => {
            commitText();
            setTool(next);
          }}
        />
        <div role="radiogroup" aria-label="Colour" className="flex items-center gap-1">
          {PEN_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={color === c.value}
              aria-label={c.label}
              title={c.label}
              onClick={() => setColor(c.value)}
              style={{ backgroundColor: c.value }}
              className={cn(
                "ring-offset-background size-5 rounded-full border outline-none focus-visible:ring-2 focus-visible:ring-ring",
                color === c.value && "ring-foreground ring-2 ring-offset-2",
              )}
            />
          ))}
        </div>
        <Segmented
          aria-label="Stroke width"
          size="sm"
          options={(["0", "1", "2"] as const).map((value, i) => ({
            value,
            ariaLabel: ["Thin", "Medium", "Thick"][i],
            label: (
              <span
                className="bg-foreground inline-block w-4 rounded-full"
                style={{ height: 2 + i * 2 }}
              />
            ),
          }))}
          value={widthIndex}
          onChange={setWidthIndex}
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Undo (Ctrl+Z)"
            disabled={history.ops.length === 0}
            onClick={() => setHistory(undo)}
          >
            <Undo2Icon />
            <span className="sr-only">Undo</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Redo (Ctrl+Shift+Z)"
            disabled={history.undone.length === 0}
            onClick={() => setHistory(redo)}
          >
            <Redo2Icon />
            <span className="sr-only">Redo</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Start over (Redo brings it back)"
            disabled={!dirty}
            // Everything moves to the redo stack, in order, so a slip is recoverable.
            onClick={() => setHistory((h) => ({ ops: [], undone: [...h.undone, ...[...h.ops].reverse()] }))}
          >
            <RotateCcwIcon />
            <span className="sr-only">Start over</span>
          </Button>
        </div>
      </div>

      <div className="bg-muted/30 relative flex h-[min(65dvh,40rem)] min-h-48 items-center justify-center overflow-hidden rounded-lg border">
        {failed ? (
          <div className="text-muted-foreground flex flex-col items-center gap-2 p-8 text-center text-sm">
            <AlertCircleIcon className="text-destructive size-5" />
            <p>This image could not be edited.</p>
            <p className="text-xs">It may no longer be staged, or it may not be a valid image.</p>
          </div>
        ) : (
          <>
            {!image && <Skeleton className="absolute inset-0 rounded-none" />}
            {/* Sized by the canvas, so the label input can be placed in
                percentages of the picture rather than of the frame. */}
            <div className="relative max-h-full max-w-full leading-none">
              <canvas
                ref={canvasRef}
                hidden={!image}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                className={cn(
                  "block max-h-[min(65dvh,40rem)] max-w-full touch-none",
                  tool === "text" ? "cursor-text" : "cursor-crosshair",
                )}
              />
              {text && (
                <input
                  autoFocus
                  value={text.value}
                  aria-label="Label text"
                  placeholder="Type, then Enter"
                  onChange={(e) => setText({ ...text, value: e.target.value })}
                  onBlur={commitText}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitText();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      setText(null);
                    }
                  }}
                  style={{
                    left: `${((text.at.x - viewport.x) / viewport.w) * 100}%`,
                    top: `${((text.at.y - viewport.y) / viewport.h) * 100}%`,
                    color,
                    fontSize: Math.max(12, textSizeFor(strokeWidth) * text.scale),
                  }}
                  className="bg-background/70 border-ring absolute min-w-24 rounded-sm border border-dashed px-0.5 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2">
        <p className="text-muted-foreground mr-auto hidden text-xs sm:block">
          {tool === "crop"
            ? "Drag to choose the part to keep."
            : tool === "text"
              ? "Click where the label goes."
              : "Drag on the picture to draw."}
        </p>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!image || !dirty || saving} onClick={() => void save()}>
          {saving && <Loader2Icon className="animate-spin" />}
          Save
        </Button>
      </div>
    </div>
  );
}
