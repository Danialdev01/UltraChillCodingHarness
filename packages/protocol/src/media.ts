/**
 * Which workspace files the browser can preview, and as what.
 *
 * One list, shared: the server decides the `Content-Type` it serves a file
 * under, and the web app decides which element to render it in. If those two
 * disagreed the result would be a broken preview at best, and at worst a file
 * served under a type it is not -- so neither owns the mapping.
 *
 * The type comes from the extension and never from the bytes. Sniffing
 * content is what `X-Content-Type-Options: nosniff` exists to stop: a file
 * whose first bytes look like HTML must not become HTML because it happened
 * to be named `.png`, and one named `.html` must not be served inline at all.
 * An extension not on this list gets no preview, which is the safe default --
 * the list grows deliberately, one reviewed entry at a time.
 */

/** How a previewable file is displayed. */
export type PreviewKind = "image" | "pdf";

/**
 * Extension to media type, for the formats worth previewing.
 *
 * SVG is here and is the one that needs saying out loud: it is a document
 * that can carry script, so it is safe *only* because of how both sides
 * handle it -- served under a locked-down CSP, and rendered in an `<img>`,
 * which never runs script in an SVG. Rendering one inline, or in an iframe
 * without that CSP, would be script execution in the app's own origin.
 */
const PREVIEWABLE: ReadonlyMap<string, { type: string; kind: PreviewKind }> = new Map([
  ["png", { type: "image/png", kind: "image" }],
  ["jpg", { type: "image/jpeg", kind: "image" }],
  ["jpeg", { type: "image/jpeg", kind: "image" }],
  ["webp", { type: "image/webp", kind: "image" }],
  ["gif", { type: "image/gif", kind: "image" }],
  ["avif", { type: "image/avif", kind: "image" }],
  ["bmp", { type: "image/bmp", kind: "image" }],
  ["ico", { type: "image/x-icon", kind: "image" }],
  ["svg", { type: "image/svg+xml", kind: "image" }],
  ["pdf", { type: "application/pdf", kind: "pdf" }],
] as const);

/** The extension in lowercase, without the dot. Empty when there is none. */
export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  // `> 0`, not `>= 0`: a leading dot is a hidden file, not an extension, so
  // `.env` has none rather than an extension of "env".
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** How to show this file, or null if the browser should not preview it. */
export function previewKindFor(path: string): PreviewKind | null {
  return PREVIEWABLE.get(extensionOf(path))?.kind ?? null;
}

/**
 * The media type to serve this file under, or null if it is not previewable.
 *
 * Null is a refusal, not a fallback: serving an unknown file inline under
 * `application/octet-stream` would still put attacker-controlled bytes on
 * this origin, and nothing in the UI would render it anyway.
 */
export function mediaTypeFor(path: string): string | null {
  return PREVIEWABLE.get(extensionOf(path))?.type ?? null;
}

/** Whether the file view should show a preview instead of the text editor. */
export function isPreviewable(path: string): boolean {
  return previewKindFor(path) !== null;
}


/**
 * Image types worth sending to a model.
 *
 * Narrower than `PREVIEWABLE` on purpose, and the gap is the point. SVG is
 * previewable here because an `<img>` will not run its script; it is *not*
 * here because it is a document rather than a bitmap, and handing a model
 * markup dressed as a picture is a prompt-injection surface with no upside.
 * BMP and ICO are left out for a duller reason: providers reject them, and a
 * refused turn is worse than an attachment the model was never shown.
 */
const MODEL_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

/** Whether a model can be shown this media type as a picture. */
export function isModelImageType(type: string): boolean {
  // Parameters are legal on a media type (`image/png; charset=binary`) and
  // the browser does occasionally send them.
  return MODEL_IMAGE_TYPES.has(type.split(";")[0]!.trim().toLowerCase());
}
