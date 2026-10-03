"use client"

import * as React from "react"
import { Extension, type Editor, type Range } from "@tiptap/core"
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion"
import { computePosition, flip, offset, shift } from "@floating-ui/dom"
import {
  CheckSquareIcon,
  SquareChevronRightIcon,
  CodeIcon,
  Columns2Icon,
  Columns3Icon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  LightbulbIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  PenToolIcon,
  PilcrowIcon,
  ShapesIcon,
  TableIcon,
  TextQuoteIcon,
  type LucideIcon,
} from "lucide-react"

import { filterSlashItems } from "@/lib/slash-filter"
import { cn } from "@/lib/utils"

/** What a slash item may ask the page for beyond the editor itself. */
export interface SlashContext {
  /** Opens the file picker; the image block is inserted once a file is chosen. */
  pickImage(): void
  /** Makes a child page and resolves with its id, so a link block can point at it. */
  createPage(): Promise<string>
}

export interface SlashItem {
  id: string
  title: string
  description: string
  icon: LucideIcon
  keywords: string[]
  run(editor: Editor, range: Range, context: SlashContext): void
}

/**
 * Everything `/` offers, in the order the menu lists it. Text first because
 * it is the way back out of a heading, blocks after, embeds last.
 */
export const SLASH_ITEMS: SlashItem[] = [
  {
    id: "text",
    title: "Text",
    description: "Plain paragraph",
    icon: PilcrowIcon,
    keywords: ["paragraph", "p"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    id: "h1",
    title: "Heading 1",
    description: "Section title",
    icon: Heading1Icon,
    keywords: ["title", "#"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    title: "Heading 2",
    description: "Sub-section",
    icon: Heading2Icon,
    keywords: ["##"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    title: "Heading 3",
    description: "Small heading",
    icon: Heading3Icon,
    keywords: ["###"],
    run: (editor, range) =>
      editor.chain().focus().deleteRange(range).setHeading({ level: 3 }).run(),
  },
  {
    id: "bullets",
    title: "Bulleted list",
    description: "A simple list",
    icon: ListIcon,
    keywords: ["ul", "unordered", "-"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "numbers",
    title: "Numbered list",
    description: "A list with numbers",
    icon: ListOrderedIcon,
    keywords: ["ol", "ordered", "1."],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    id: "tasks",
    title: "To-do list",
    description: "Checkboxes to tick",
    icon: CheckSquareIcon,
    keywords: ["todo", "task", "checkbox", "[]"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    id: "quote",
    title: "Quote",
    description: "A pulled-out passage",
    icon: TextQuoteIcon,
    keywords: ["blockquote", ">"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setBlockquote().run(),
  },
  {
    id: "code",
    title: "Code",
    description: "A code snippet",
    icon: CodeIcon,
    keywords: ["codeblock", "```", "snippet"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCodeBlock().run(),
  },
  {
    id: "divider",
    title: "Divider",
    description: "A horizontal rule",
    icon: MinusIcon,
    keywords: ["hr", "rule", "---", "separator"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    id: "table",
    title: "Table",
    description: "3 by 3, with a header row",
    icon: TableIcon,
    keywords: ["grid", "rows", "columns"],
    run: (editor, range) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    id: "callout",
    title: "Callout",
    description: "A tinted box with an icon",
    icon: LightbulbIcon,
    keywords: ["note", "tip", "info", "warning", "aside"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setCallout().run(),
  },
  {
    id: "toggle",
    title: "Toggle list",
    description: "A line that folds blocks under it",
    icon: SquareChevronRightIcon,
    keywords: ["details", "collapse", "accordion", "fold", "expand"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).setDetails().run(),
  },
  {
    id: "columns2",
    title: "2 columns",
    description: "Blocks side by side",
    icon: Columns2Icon,
    keywords: ["column", "layout", "split", "two"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertColumns(2).run(),
  },
  {
    id: "columns3",
    title: "3 columns",
    description: "Three across",
    icon: Columns3Icon,
    keywords: ["column", "layout", "split", "three"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertColumns(3).run(),
  },
  {
    id: "image",
    title: "Image",
    description: "Upload a picture",
    icon: ImageIcon,
    keywords: ["picture", "photo", "png", "jpg", "upload"],
    run: (editor, range, context) => {
      editor.chain().focus().deleteRange(range).run()
      context.pickImage()
    },
  },
  {
    id: "page",
    title: "Page",
    description: "A new page inside this one",
    icon: FileTextIcon,
    keywords: ["subpage", "child", "nested", "new"],
    run: (editor, range, context) => {
      editor.chain().focus().deleteRange(range).run()
      void context.createPage().then((noteId) => {
        editor.chain().focus().insertPageLink({ noteId }).run()
      })
    },
  },
  {
    id: "embed",
    title: "Embed",
    description: "A video, a design, or any page, framed",
    icon: GlobeIcon,
    keywords: ["video", "youtube", "vimeo", "figma", "iframe", "url", "link", "loom"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertEmbed().run(),
  },
  {
    id: "mermaid",
    title: "Mermaid diagram",
    description: "Flowchart, sequence, ER -- from text",
    icon: GitBranchIcon,
    keywords: ["diagram", "flowchart", "sequence", "chart", "graph"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertMermaid().run(),
  },
  {
    id: "whiteboard",
    title: "Whiteboard",
    description: "A freehand canvas (tldraw)",
    icon: PenToolIcon,
    keywords: ["tldraw", "draw", "sketch", "canvas", "board"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertTldraw().run(),
  },
  {
    id: "drawio",
    title: "Diagram (draw.io)",
    description: "Shapes and connectors, in diagrams.net",
    icon: ShapesIcon,
    keywords: ["drawio", "diagrams.net", "architecture", "shapes", "flow"],
    run: (editor, range) => editor.chain().focus().deleteRange(range).insertDrawio().run(),
  },
]

/** The menu as the React side sees it: what to show and where. */
export interface SlashMenuState {
  items: SlashItem[]
  command: (item: SlashItem) => void
  clientRect: (() => DOMRect | null) | null | undefined
}

export interface SlashCommandOptions {
  context: SlashContext
  /** Called with the menu to show, or null to close it. */
  onState(state: SlashMenuState | null): void
  /**
   * The menu's own key handling; returns true when it took the key.
   *
   * A function, not a ref object: `configure` deep-merges options, and a
   * plain `{ current }` would be copied rather than shared with the menu.
   */
  onKeyDown(event: KeyboardEvent): boolean
}

/**
 * `/` at the start of a block or after a space opens the block menu.
 *
 * The suggestion plugin does the matching and hands the React side a state
 * to render; arrow keys and enter come back through `keydown` so the menu,
 * not ProseMirror, decides what they do while it is open.
 */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      context: { pickImage: () => {}, createPage: async () => "" },
      onState: () => {},
      onKeyDown: () => false,
    }
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        char: "/",
        allowSpaces: false,
        startOfLine: false,
        items: ({ query }) => filterSlashItems(query, SLASH_ITEMS),
        command: ({ editor, range, props }) => props.run(editor, range, options.context),
        allow: ({ state, range }) => {
          // Not inside a code block: a slash there is code.
          const $from = state.doc.resolve(range.from)
          return $from.parent.type.spec.code !== true
        },
        render: () => {
          const publish = (props: SuggestionProps<SlashItem, SlashItem>) =>
            options.onState({
              items: props.items,
              command: props.command,
              clientRect: props.clientRect,
            })
          return {
            onStart: publish,
            onUpdate: publish,
            onExit: () => options.onState(null),
            onKeyDown: ({ event }: SuggestionKeyDownProps) => options.onKeyDown(event),
          }
        },
      }),
    ]
  },
})

/**
 * The floating list of blocks. Anchored to the caret with floating-ui, kept
 * on screen, and driven by the keys the extension forwards.
 */
export function SlashMenu({
  state,
  keydown,
}: {
  state: SlashMenuState | null
  keydown: React.MutableRefObject<(event: KeyboardEvent) => boolean>
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [index, setIndex] = React.useState(0)
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null)

  const items = state?.items ?? []
  const count = items.length

  // Back to the top whenever the list changes under the highlight.
  React.useEffect(() => setIndex(0), [state?.items])

  React.useEffect(() => {
    const element = ref.current
    const rect = state?.clientRect?.()
    if (!element || !rect) {
      setPosition(null)
      return
    }
    const reference = { getBoundingClientRect: () => rect }
    void computePosition(reference, element, {
      strategy: "fixed",
      placement: "bottom-start",
      middleware: [offset(6), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => setPosition({ x, y }))
  }, [state])

  React.useEffect(() => {
    keydown.current = (event) => {
      if (!state || count === 0) return false
      if (event.key === "ArrowDown") {
        setIndex((i) => (i + 1) % count)
        return true
      }
      if (event.key === "ArrowUp") {
        setIndex((i) => (i - 1 + count) % count)
        return true
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const item = items[index]
        if (item) state.command(item)
        return true
      }
      return false
    }
  }, [keydown, state, items, index, count])

  React.useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [index])

  if (!state) return null

  return (
    <div
      ref={ref}
      role="listbox"
      className="bg-popover text-popover-foreground fixed z-50 max-h-80 w-72 overflow-y-auto rounded-md border p-1 shadow-md"
      style={{
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {count === 0 ? (
        <p className="text-muted-foreground px-2 py-1.5 text-xs">No matching block</p>
      ) : (
        items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={i === index}
            data-index={i}
            onMouseEnter={() => setIndex(i)}
            onMouseDown={(event) => {
              event.preventDefault()
              state.command(item)
            }}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left text-sm",
              i === index && "bg-muted",
            )}
          >
            <span className="bg-background flex size-8 shrink-0 items-center justify-center rounded border">
              <item.icon className="text-muted-foreground size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate">{item.title}</span>
              <span className="text-muted-foreground block truncate text-xs">{item.description}</span>
            </span>
          </button>
        ))
      )}
    </div>
  )
}
