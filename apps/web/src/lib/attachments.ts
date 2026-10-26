/**
 * Files picked in the composer, on their way into a message.
 *
 * Every attachment is uploaded to staging as soon as it is chosen -- a
 * directory outside the project's working tree -- and the message that
 * carries it references it by id rather than by content. That is what makes
 * "add this file to the directory" work for a photo: the bytes are already on
 * the server, and `attach_upload` moves them in at a path the model chooses.
 * Nothing lands in the project, in `git status`, or within the agent's reach
 * until that happens.
 *
 * Text files are additionally inlined, up to a size cap. Not a duplicate of
 * the upload but a shortcut past it: a question about a 40-line config is
 * answered from the message itself, with no tool call and no file written
 * into a repository that did not ask for one.
 */

import { isModelImageType, previewKindFor } from "@ucch/protocol/plain";
import type { MessageImage } from "@ucch/protocol";

/**
 * The most one file may contribute as inlined text. Past this the content is
 * left out and the upload is the only way in: a 40 MB log pasted into a
 * prompt is a failed turn and a bill, not a long turn.
 */
export const MAX_INLINE_BYTES = 256 * 1024;

/** Extensions that are text even when the browser offers no MIME type. */
const TEXT_EXTENSIONS = new Set([
  "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "diff", "dockerfile", "env", "go",
  "gql", "graphql", "h", "hpp", "htm", "html", "ini", "java", "js", "json", "jsonc", "jsx",
  "kt", "less", "lock", "log", "lua", "md", "mdx", "mjs", "patch", "php", "pl", "properties",
  "py", "rb", "rs", "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsv", "tsx", "txt",
  "vue", "xml", "yaml", "yml", "zsh",
]);

/** MIME types outside `text/*` whose payload is still readable as text. */
const TEXT_MIME = /^application\/(json|xml|javascript|x-yaml|x-sh|sql|graphql)/;

export interface PickedFile {
  name: string;
  size: number;
  type: string;
}

/** Whether a file's content can be read into the message as text. */
export function isTextual(file: PickedFile): boolean {
  if (file.type.startsWith("text/") || TEXT_MIME.test(file.type)) return true;
  // An empty `type` is ordinary: browsers only know the MIME types their
  // platform registers, and source files are exactly the ones they miss.
  if (file.type && !file.type.startsWith("application/")) return false;
  const dot = file.name.lastIndexOf(".");
  if (dot < 1) return false;
  return TEXT_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase());
}

/** A size a person can read, in the units they would have said it in. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Where one attachment has got to. */
export type AttachmentStatus = "uploading" | "staged" | "failed";

export interface Attachment extends PickedFile {
  /** Stable across re-renders, so removing one does not disturb the others. */
  id: string;
  /** The content, when it is text small enough to inline. */
  text: string | null;
  /** The staging id, once the server has it. Null while uploading or failed. */
  uploadId: string | null;
  status: AttachmentStatus;
  /** Why the upload failed, for the chip and for the message. */
  error?: string;
}

/**
 * A fence long enough to survive the content.
 *
 * A Markdown file that itself contains ``` would otherwise close the block
 * early and spill the rest of the file into the conversation as prose.
 */
function fenceFor(text: string): string {
  const longest = [...text.matchAll(/`{3,}/g)].reduce((n, m) => Math.max(n, m[0].length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/** The label an attachment gets in the message and on its chip. */
export function describeAttachment(file: Attachment): string {
  // The MIME type earns its place on a file whose content is not in the
  // message -- it is how the model knows what it is being offered.
  const kind = file.text === null ? `${file.type || "binary"}, ` : "";
  return `${file.name} (${kind}${formatBytes(file.size)})`;
}

/** Why an attachment's content was not inlined, or null when it was. */
export function excludedReason(file: Attachment): string | null {
  if (file.text !== null) return null;
  if (!isTextual(file)) return "not text";
  return `over ${formatBytes(MAX_INLINE_BYTES)}`;
}

/** Whether this attachment is staged and can be placed into the project. */
export function isPlaceable(file: Attachment): boolean {
  return file.status === "staged" && file.uploadId !== null;
}

/**
 * Where the attachment block starts.
 *
 * Everything from this marker to the end of the message is for the model,
 * not the reader: the chat strips it and draws a tag per file instead. A
 * marker rather than a parsed structure because it makes stripping exact --
 * attachments are always last, so the first occurrence wins and nothing a
 * file's own content happens to contain can close the block early.
 */
export const ATTACHMENTS_MARKER = "<ucch:attachments>";

/** One attachment as the manifest carries it, for the tag and for the model. */
export interface MessageAttachment {
  name: string;
  size: number;
  type: string;
  /** Null when the upload failed, so nothing offers an id that is not there. */
  uploadId: string | null;
}

/** The content of a text file, fenced, for the model to read directly. */
function inlined(file: Attachment): string {
  if (file.text === null) return "";
  const fence = fenceFor(file.text);
  return `\n\n--- ${file.name} ---\n${fence}\n${file.text}\n${fence}`;
}

/**
 * The text actually sent: what was typed, then the attachment block.
 *
 * The typed message is the whole of what the reader sees; everything the
 * model needs in order to act on a file -- its id, that it is staged outside
 * the workspace, and the tool that moves it in -- goes after the marker,
 * said once rather than once per file. The manifest is JSON because both
 * ends read it: the model to get an id, the chat to draw a tag.
 *
 * With no attachments this returns the draft untouched, so an ordinary
 * message is not reshaped by a feature it did not use.
 */
export function composeMessage(draft: string, attachments: readonly Attachment[]): string {
  const text = draft.trim();
  if (attachments.length === 0) return text;

  const manifest: MessageAttachment[] = attachments.map((file) => ({
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    uploadId: isPlaceable(file) ? file.uploadId : null,
  }));

  const failed = attachments.filter((file) => !isPlaceable(file));
  const notes = failed.length
    ? `\n${failed
        .map((file) => `${file.name} failed to upload${file.error ? `: ${file.error}` : ""}.`)
        .join("\n")}`
    : "";

  const block =
    `${ATTACHMENTS_MARKER}\n` +
    "Files attached to this message. They are staged OUTSIDE the workspace: to add one " +
    "to the project, call attach_upload with its upload_id and a path. " +
    "A file with a null upload_id is not available.\n" +
    `${JSON.stringify(manifest)}${notes}` +
    attachments.map(inlined).join("");

  return [text, block].filter(Boolean).join("\n\n");
}

/**
 * Splits a stored message back into what to show and what to tag.
 *
 * The chat renders from the log, so this is the only thing standing between
 * the reader and a wall of ids and fenced file contents. A block it cannot
 * parse is left in the text rather than dropped: showing something ugly beats
 * silently hiding what the model was actually told.
 */
export function parseAttachments(message: string): {
  text: string;
  attachments: MessageAttachment[];
} {
  const at = message.indexOf(ATTACHMENTS_MARKER);
  if (at === -1) return { text: message, attachments: [] };

  const json = message
    .slice(at + ATTACHMENTS_MARKER.length)
    .split("\n")
    .find((line) => line.startsWith("[") && line.endsWith("]"));

  try {
    const parsed: unknown = JSON.parse(json ?? "");
    if (!Array.isArray(parsed)) return { text: message, attachments: [] };
    return {
      text: message.slice(0, at).trimEnd(),
      attachments: parsed.filter(isMessageAttachment),
    };
  } catch {
    return { text: message, attachments: [] };
  }
}

function isMessageAttachment(value: unknown): value is MessageAttachment {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.name === "string" &&
    typeof a.size === "number" &&
    typeof a.type === "string" &&
    (typeof a.uploadId === "string" || a.uploadId === null)
  );
}

/**
 * A picked file as an attachment, before the upload has been attempted.
 *
 * Text content is read here rather than after the upload, so a small file is
 * legible in the message even if staging fails.
 */
export async function readAttachment(file: File, id: string): Promise<Attachment> {
  const base: Attachment = {
    id,
    name: file.name,
    size: file.size,
    type: file.type,
    text: null,
    uploadId: null,
    status: "uploading",
  };
  if (!isTextual(base) || file.size > MAX_INLINE_BYTES) return base;
  try {
    return { ...base, text: await file.text() };
  } catch {
    // Unreadable as text is not a failure: the upload still carries it.
    return base;
  }
}

/**
 * The most pictures one message may show the model.
 *
 * Matches the cap the `thread.send` command validates against. Enforced here
 * too, because a ninth image would not be trimmed on the way in -- it would
 * fail the whole command, losing the message along with the attachment.
 */
export const MAX_MODEL_IMAGES = 8;

/**
 * The attachments this message should show the model, rather than describe.
 *
 * A subset of the attachments, not a replacement for them: the manifest still
 * lists every file, and the ones named here are additionally sent as pictures
 * so a screenshot can be looked at instead of read about. Only staged files in
 * a format providers decode qualify -- anything else stays a described file,
 * which is what the model can still act on.
 */
/**
 * How many pictures the message will carry once every upload lands.
 *
 * Counts the ones still uploading as well as the staged, unlike
 * `modelImages`: this is for warning that the model cannot see them, and
 * the warning should appear as the picture is dropped rather than a moment
 * later when its upload finishes. A failed upload never reaches the model,
 * so it is not counted.
 */
export function pendingImageCount(attachments: readonly Attachment[]): number {
  return attachments.filter((file) => file.status !== "failed" && isModelImageType(file.type))
    .length;
}

export function modelImages(attachments: readonly Attachment[]): MessageImage[] {
  return attachments
    .filter((file) => isPlaceable(file) && isModelImageType(file.type))
    .slice(0, MAX_MODEL_IMAGES)
    .map((file) => ({ uploadId: file.uploadId!, name: file.name, type: file.type }));
}

/** The part of a paste event this needs, so a test can hand it one. */
export interface ClipboardLike {
  files: ArrayLike<File>;
  types: readonly string[];
}

/**
 * The files on the clipboard, ready to be staged.
 *
 * A pasted screenshot arrives here as a file with no useful name -- every one
 * of them is `image.png`, when it is named at all -- so pictures are renamed
 * on the way in. Two pastes would otherwise produce two identical chips, and
 * the one thing the reader needs from a chip is to tell it from the other one.
 *
 * Non-image files are left exactly as they came: a file copied out of a file
 * manager already has the name the person knows it by.
 */
export function clipboardFiles(data: ClipboardLike, at: number = Date.now()): File[] {
  return Array.from(data.files ?? []).map((file, i) =>
    file.type.startsWith("image/") && isGenericName(file.name)
      ? renamed(file, pastedName(file.type, at, i))
      : file,
  );
}

/**
 * Whether a paste carrying files should still insert text as well.
 *
 * Rich text often travels with a picture of itself -- a spreadsheet range, a
 * slide, a table out of a document -- and there the text is what was meant and
 * the image is a bonus. So the files are attached either way and the paste is
 * only swallowed when there was nothing to type: a screenshot, which has no
 * text at all.
 */
export function pasteCarriesText(data: ClipboardLike): boolean {
  return (data.types ?? []).includes("text/plain");
}

/** A name the clipboard invented, as opposed to one a person would know. */
function isGenericName(name: string): boolean {
  return name === "" || /^image\.[a-z0-9]+$/i.test(name);
}

/** `pasted-<time>.png`, numbered when one paste carries several. */
function pastedName(type: string, at: number, index: number): string {
  const stamp = new Date(at).toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `pasted-${stamp}${suffix}.${imageExtension(type)}`;
}

/** The extension for an image media type, for naming a pasted one. */
function imageExtension(type: string): string {
  const subtype = type.split(";")[0]!.trim().toLowerCase().split("/")[1] ?? "";
  if (subtype === "jpeg") return "jpg";
  if (subtype === "svg+xml") return "svg";
  return /^[a-z0-9]+$/.test(subtype) ? subtype : "bin";
}

/**
 * The same bytes under a better name.
 *
 * A `File` is immutable, so renaming one means building another around it.
 * A browser too old for the constructor keeps the name it had, which is a
 * duller chip and not a lost attachment.
 */
function renamed(file: File, name: string): File {
  try {
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/**
 * How an attachment can be shown, or null when it can only be downloaded.
 *
 * "text" is this app's own addition to the two kinds `previewKindFor` knows
 * about: the server will not serve a text file inline -- that would be a
 * document on this origin -- so text is fetched as a string and put into an
 * element instead, which is a different mechanism and so a different kind.
 */
export type PreviewKind = "image" | "pdf" | "text";

/**
 * Which preview an attachment gets.
 *
 * The extension decides, through the same allow-list the server serves by, so
 * the dialog never offers a preview the bytes will be refused for. Null is the
 * ordinary answer for an archive or a binary: there is nothing to show, and the
 * download is the whole of what can be offered.
 */
export function previewKindOf(file: PickedFile): PreviewKind | null {
  const kind = previewKindFor(file.name);
  if (kind) return kind;
  return isTextual(file) ? "text" : null;
}
