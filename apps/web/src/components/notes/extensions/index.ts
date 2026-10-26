import type { Extensions } from "@tiptap/core"
import { common, createLowlight } from "lowlight"
import StarterKit from "@tiptap/starter-kit"
import Collaboration from "@tiptap/extension-collaboration"
import CollaborationCaret from "@tiptap/extension-collaboration-caret"
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight"
import Highlight from "@tiptap/extension-highlight"
import Placeholder from "@tiptap/extension-placeholder"
import TaskItem from "@tiptap/extension-task-item"
import TaskList from "@tiptap/extension-task-list"
import { TableKit } from "@tiptap/extension-table"
import { Markdown } from "@tiptap/markdown"
import type { HocuspocusProvider } from "@hocuspocus/provider"

import { BlockHandle, type BlockHandleOptions } from "./block-handle"
import { BlockSelectionExtension } from "./block-selection"
import { Callout } from "./callout"
import { Column, Columns } from "./columns"
import { Details, DetailsContent, DetailsSummary } from "./details"
import { Drawio } from "./drawio"
import { Embed } from "./embed"
import { Mermaid } from "./mermaid"
import { NoteImage } from "./note-image"
import { PageLink } from "./page-link"
import { SlashCommand, type SlashCommandOptions } from "./slash-command"
import { TextColorMark } from "./text-color"
import { TldrawBlock } from "./tldraw"

const lowlight = createLowlight(common)

/** A page shared live: its Yjs document's provider, and who this tab is to the others. */
export interface CollabOptions {
  provider: HocuspocusProvider
  field: string
  user: { name: string; color: string }
}

/**
 * The editor's schema: everything a page may hold.
 *
 * StarterKit v3 already brings links, underline, the drop cursor and a
 * trailing paragraph (so an embed at the end of a page can always be typed
 * after). The rest is what Notion has and the kit does not. The Markdown
 * extension comes after the nodes with their own Markdown, so it sees them.
 *
 * With `collab`, the document is the shared Yjs one: undo is Yjs's (which
 * undoes only this tab's edits, not a collaborator's), so the kit's own
 * history is off, and the others' carets are drawn in their colours.
 */
export function buildExtensions(
  slash: SlashCommandOptions,
  blockHandle: BlockHandleOptions,
  collab?: CollabOptions,
): Extensions {
  return [
    StarterKit.configure({
      codeBlock: false,
      ...(collab ? { undoRedo: false as const } : {}),
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
      },
      heading: { levels: [1, 2, 3] },
    }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    Placeholder.configure({
      placeholder: ({ node }) => {
        if (node.type.name === "heading") return `Heading ${node.attrs.level}`
        if (node.type.name === "detailsSummary") return "Toggle title"
        return "Type / for blocks, or just write…"
      },
      // Only the block at the cursor carries the hint (the default), so at
      // most one shows at a time: on the empty page, and on the focused
      // line, which is what Notion does. The CSS decides between the two.
      includeChildren: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    NoteImage.configure({ inline: false, allowBase64: false }),
    Highlight,
    TextColorMark,
    Callout,
    Details,
    DetailsSummary,
    DetailsContent,
    Columns,
    Column,
    Embed,
    Markdown,
    PageLink,
    Mermaid,
    TldrawBlock,
    Drawio,
    SlashCommand.configure(slash),
    BlockHandle.configure(blockHandle),
    BlockSelectionExtension,
    ...(collab
      ? [
          Collaboration.configure({ document: collab.provider.document, field: collab.field }),
          CollaborationCaret.configure({
            provider: collab.provider,
            user: collab.user,
            render: renderCaret,
            selectionRender: (user) => ({
              nodeName: "span",
              class: "collaboration-carets__selection",
              style: `background-color: color-mix(in oklch, ${caretColor(user.color)} 25%, transparent)`,
            }),
          }),
        ]
      : []),
  ]
}

/**
 * A collaborator's colour, as their tab announced it. It lands in a style
 * attribute, so only the shape `personColor` makes is let through; the kit's
 * own renderer would accept hex alone, which is why the carets are drawn here.
 */
function caretColor(color: unknown): string {
  return typeof color === "string" && /^oklch\([\d.\s]+\)$/.test(color) ? color : "var(--muted-foreground)"
}

/** Another person's caret: a thin bar in their colour, their name above it. */
function renderCaret(user: Record<string, unknown>): HTMLElement {
  const color = caretColor(user.color)
  const caret = document.createElement("span")
  caret.className = "collaboration-carets__caret"
  caret.style.borderColor = color
  const label = document.createElement("div")
  label.className = "collaboration-carets__label"
  label.style.backgroundColor = color
  label.textContent = typeof user.name === "string" && user.name ? user.name : "Someone"
  caret.append(label)
  return caret
}
