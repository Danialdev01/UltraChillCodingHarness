"use client"

import * as React from "react"
import type { Editor } from "@tiptap/core"
import { BubbleMenu } from "@tiptap/react/menus"
import {
  BaselineIcon,
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  HighlighterIcon,
  ItalicIcon,
  LightbulbIcon,
  LinkIcon,
  ListIcon,
  StrikethroughIcon,
  TextQuoteIcon,
  UnderlineIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { BlockSelection } from "./block-selection"
import { TEXT_COLORS } from "./text-color"

/**
 * The formatting bar that floats over a selection.
 *
 * Marks on the left, block turns on the right; each button lights when its
 * format is already on, so the bar also says what the selection is.
 */
export function NoteBubbleMenu({ editor }: { editor: Editor }) {
  const [linkOpen, setLinkOpen] = React.useState(false)
  const [href, setHref] = React.useState("")

  return (
    <BubbleMenu
      editor={editor}
      options={{ placement: "top", offset: 8 }}
      shouldShow={({ editor: e, from, to }) => {
        if (from === to) return false
        // Whole blocks picked have the gutter menu, not the text one.
        if (e.state.selection instanceof BlockSelection) return false
        // Not over the blocks that manage themselves: code, and the embeds.
        if (e.isActive("codeBlock")) return false
        const $from = e.state.doc.resolve(from)
        return $from.parent.type.spec.code !== true && !e.state.selection.toJSON().type?.startsWith("node")
      }}
      className="bg-popover text-popover-foreground flex items-center gap-0.5 rounded-md border p-0.5 shadow-md"
    >
      {linkOpen ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            const url = href.trim()
            if (url) editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run()
            else editor.chain().focus().extendMarkRange("link").unsetLink().run()
            setLinkOpen(false)
          }}
        >
          <input
            autoFocus
            value={href}
            onChange={(event) => setHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setLinkOpen(false)
            }}
            placeholder="https://"
            className="bg-background h-7 w-56 border-input rounded border px-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" size="xs" variant="secondary">
            Set
          </Button>
        </form>
      ) : (
        <>
          <Mark editor={editor} icon={BoldIcon} name="bold" title="Bold" onClick={() => editor.chain().focus().toggleBold().run()} />
          <Mark editor={editor} icon={ItalicIcon} name="italic" title="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} />
          <Mark editor={editor} icon={UnderlineIcon} name="underline" title="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} />
          <Mark editor={editor} icon={StrikethroughIcon} name="strike" title="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} />
          <Mark editor={editor} icon={CodeIcon} name="code" title="Inline code" onClick={() => editor.chain().focus().toggleCode().run()} />
          <Mark editor={editor} icon={HighlighterIcon} name="highlight" title="Highlight" onClick={() => editor.chain().focus().toggleHighlight().run()} />
          <ColorMenu editor={editor} />
          <Mark
            editor={editor}
            icon={LinkIcon}
            name="link"
            title="Link"
            onClick={() => {
              setHref((editor.getAttributes("link").href as string | undefined) ?? "")
              setLinkOpen(true)
            }}
          />
          <span className="bg-border mx-0.5 h-4 w-px" />
          <Mark editor={editor} icon={Heading1Icon} name="heading" attrs={{ level: 1 }} title="Heading 1" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} />
          <Mark editor={editor} icon={Heading2Icon} name="heading" attrs={{ level: 2 }} title="Heading 2" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} />
          <Mark editor={editor} icon={ListIcon} name="bulletList" title="Bulleted list" onClick={() => editor.chain().focus().toggleBulletList().run()} />
          <Mark editor={editor} icon={TextQuoteIcon} name="blockquote" title="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()} />
          <Mark
            editor={editor}
            icon={LightbulbIcon}
            name="callout"
            title="Callout"
            onClick={() =>
              editor.isActive("callout")
                ? editor.chain().focus().unsetCallout().run()
                : editor.chain().focus().setCallout().run()
            }
          />
        </>
      )}
    </BubbleMenu>
  )
}

/** The text colour swatches: the palette's names, and the way back to none. */
function ColorMenu({ editor }: { editor: Editor }) {
  const current = editor.getAttributes("textColor").color as string | undefined
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            title="Text colour"
            aria-pressed={Boolean(current)}
            className={cn(current && "bg-muted")}
            onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
          />
        }
      >
        <BaselineIcon className="ucch-text-color" data-color={current} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onMouseDown={(event) => event.preventDefault()}>
        <DropdownMenuItem onClick={() => editor.chain().focus().unsetTextColor().run()}>
          <span className="size-3.5 rounded-sm border" aria-hidden />
          Default
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {TEXT_COLORS.map((color) => (
          <DropdownMenuItem
            key={color}
            onClick={() => editor.chain().focus().setTextColor(color).run()}
            className={cn(current === color && "bg-muted")}
          >
            <span
              className="ucch-text-color size-3.5 rounded-sm border bg-current"
              data-color={color}
              aria-hidden
            />
            <span className="capitalize">{color}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Mark({
  editor,
  icon: Icon,
  name,
  attrs,
  title,
  onClick,
}: {
  editor: Editor
  icon: LucideIcon
  name: string
  attrs?: Record<string, unknown>
  title: string
  onClick(): void
}) {
  const active = editor.isActive(name, attrs)
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      title={title}
      aria-pressed={active}
      className={cn(active && "bg-muted text-ucch-active")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon />
    </Button>
  )
}
