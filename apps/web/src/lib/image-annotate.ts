/**
 * The arithmetic behind marking up and cropping an attached image.
 *
 * An edit is a list of operations over the original picture, every coordinate
 * in its own pixels. Nothing is ever painted into the source: the editor
 * redraws image + operations on each change, and the saved file is one more
 * such draw onto a canvas the size of the crop. That is what makes undo exact
 * and a crop reversible -- a stroke drawn before cropping is still there, in
 * the same place, if the crop is undone.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Op =
  | { kind: "stroke"; points: Point[]; color: string; width: number }
  | { kind: "arrow"; from: Point; to: Point; color: string; width: number }
  | { kind: "rect"; from: Point; to: Point; color: string; width: number }
  | { kind: "text"; at: Point; text: string; color: string; size: number }
  | { kind: "crop"; rect: Rect };

/** What has been done, and what has been undone and can come back. */
export interface History {
  ops: readonly Op[];
  undone: readonly Op[];
}

export const EMPTY_HISTORY: History = { ops: [], undone: [] };

/** A new operation. Doing something new forgets what was undone, as everywhere. */
export function push(history: History, op: Op): History {
  return { ops: [...history.ops, op], undone: [] };
}

export function undo(history: History): History {
  const last = history.ops.at(-1);
  if (!last) return history;
  return { ops: history.ops.slice(0, -1), undone: [...history.undone, last] };
}

export function redo(history: History): History {
  const next = history.undone.at(-1);
  if (!next) return history;
  return { ops: [...history.ops, next], undone: history.undone.slice(0, -1) };
}

/** The smallest crop, in image pixels: a stray click must not make an empty picture. */
export const MIN_CROP = 8;

/** The rectangle two corners describe, whichever way it was dragged. */
export function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/** A rectangle trimmed to the image and snapped to whole pixels. */
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width, Math.round(rect.x)));
  const y = Math.max(0, Math.min(height, Math.round(rect.y)));
  const right = Math.max(x, Math.min(width, Math.round(rect.x + rect.w)));
  const bottom = Math.max(y, Math.min(height, Math.round(rect.y + rect.h)));
  return { x, y, w: right - x, h: bottom - y };
}

/** Whether a dragged crop is big enough to be meant. */
export function isUsableCrop(rect: Rect): boolean {
  return rect.w >= MIN_CROP && rect.h >= MIN_CROP;
}

/** The region the picture is cut to: the latest crop, or all of it. */
export function currentCrop(ops: readonly Op[], width: number, height: number): Rect {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (op.kind === "crop") return op.rect;
  }
  return { x: 0, y: 0, w: width, h: height };
}

/**
 * A pointer position in image pixels.
 *
 * `box` is where the canvas is on screen (its bounding rect); `viewport` is the
 * part of the image the canvas is showing. The canvas is scaled by CSS, so the
 * two differ by a factor that is not 1 on anything but a small image.
 */
export function toImagePoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  viewport: Rect,
): Point {
  if (box.width <= 0 || box.height <= 0) return { x: viewport.x, y: viewport.y };
  return {
    x: viewport.x + ((clientX - box.left) * viewport.w) / box.width,
    y: viewport.y + ((clientY - box.top) * viewport.h) / box.height,
  };
}

/**
 * The two barb ends of an arrow pointing at `to`.
 *
 * Sized from the stroke so a thick arrow does not end in a pin, and capped by
 * the shaft so a short arrow is not all head.
 */
export function arrowHead(from: Point, to: Point, width: number): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const shaft = Math.hypot(to.x - from.x, to.y - from.y);
  const length = Math.min(Math.max(10, width * 4), shaft * 0.6 || width * 4);
  const spread = Math.PI / 7;
  return [
    {
      x: to.x - length * Math.cos(angle - spread),
      y: to.y - length * Math.sin(angle - spread),
    },
    {
      x: to.x - length * Math.cos(angle + spread),
      y: to.y - length * Math.sin(angle + spread),
    },
  ];
}

/**
 * The stroke widths on offer, in image pixels.
 *
 * Scaled to the picture: a 4px line is bold on a 600px crop and invisible on a
 * 4K screenshot shown at a quarter of its size. The base is the image's longer
 * side, so the same choice looks about the same on screen whatever was pasted.
 */
export function strokeWidths(width: number, height: number): [number, number, number] {
  const unit = Math.max(1, Math.max(width, height) / 400);
  return [Math.round(unit * 1.5) || 1, Math.round(unit * 3) || 2, Math.round(unit * 6) || 4];
}

/** The text size for a stroke width: big enough to read next to the line it labels. */
export function textSizeFor(strokeWidth: number): number {
  return Math.max(12, Math.round(strokeWidth * 6));
}

/** What the edited file is saved as: the formats worth keeping, else PNG. */
export function outputType(type: string): "image/png" | "image/jpeg" | "image/webp" {
  const base = type.split(";")[0]!.trim().toLowerCase();
  if (base === "image/jpeg" || base === "image/jpg") return "image/jpeg";
  if (base === "image/webp") return "image/webp";
  return "image/png";
}

const EXTENSION: Record<ReturnType<typeof outputType>, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * `shot.png` → `shot-edited.png`, with the extension the new bytes have.
 *
 * Editing an edit keeps one suffix rather than growing `-edited-edited`: the
 * name says what the file is, not how many times it was touched.
 */
export function editedName(name: string, type: string): string {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name) || "image";
  const base = stem.endsWith("-edited") ? stem : `${stem}-edited`;
  return `${base}.${EXTENSION[outputType(type)]}`;
}

/** The context the drawing needs, so a test could hand it a recorder. */
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draws one annotation. Crops are not drawn; they move the viewport. */
export function drawOp(ctx: Ctx, op: Op): void {
  if (op.kind === "crop") return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (op.kind === "text") {
    ctx.fillStyle = op.color;
    ctx.font = `600 ${op.size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = "top";
    // A thin halo in the opposite tone keeps a label readable on a busy shot.
    ctx.lineWidth = Math.max(2, op.size / 8);
    ctx.strokeStyle = isLight(op.color) ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.85)";
    op.text.split("\n").forEach((line, i) => {
      const y = op.at.y + i * op.size * 1.2;
      ctx.strokeText(line, op.at.x, y);
      ctx.fillText(line, op.at.x, y);
    });
    ctx.restore();
    return;
  }
  ctx.strokeStyle = op.color;
  ctx.lineWidth = op.width;
  ctx.beginPath();
  if (op.kind === "stroke") {
    const [first, ...rest] = op.points;
    if (first) {
      ctx.moveTo(first.x, first.y);
      // A single tap is a dot, not nothing.
      if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y);
      for (const p of rest) ctx.lineTo(p.x, p.y);
    }
  } else if (op.kind === "rect") {
    const r = normalizeRect(op.from, op.to);
    ctx.rect(r.x, r.y, r.w, r.h);
  } else {
    const [a, b] = arrowHead(op.from, op.to, op.width);
    ctx.moveTo(op.from.x, op.from.y);
    ctx.lineTo(op.to.x, op.to.y);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(op.to.x, op.to.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Whether a `#rrggbb` color is light, to pick the halo behind text. */
export function isLight(color: string): boolean {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return false;
  const n = parseInt(m[1]!, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160;
}

/**
 * The pen colours.
 *
 * Fixed, not theme tokens: they are burnt into a picture the model and other
 * people will see, which has no theme. Red first because a screenshot is most
 * often marked to say "this, here".
 */
export const PEN_COLORS = [
  { value: "#ef4444", label: "Red" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#22c55e", label: "Green" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#111827", label: "Black" },
  { value: "#ffffff", label: "White" },
] as const;

/** Dims everything outside `rect` and outlines it, for the crop tool. */
export function drawCropShade(ctx: Ctx, full: Rect, rect: Rect, lineWidth: number): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.beginPath();
  ctx.rect(full.x, full.y, full.w, full.h);
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.fill("evenodd");
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = lineWidth;
  ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
  ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();
}
