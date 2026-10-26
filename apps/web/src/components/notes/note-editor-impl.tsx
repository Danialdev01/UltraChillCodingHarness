"use client"

import * as React from "react"
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react"
import {
  AlertTriangleIcon,
  CheckIcon,
  ClipboardCopyIcon,
  FileDownIcon,
  FileUpIcon,
  ImagePlusIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  SmilePlusIcon,
  Trash2Icon,
  WifiOffIcon,
} from "lucide-react"

import { EmojiPicker } from "@/components/notes/emoji-picker"
import { useBlockBand } from "@/components/notes/extensions/block-band"
import { BlockHandles, type BlockHover } from "@/components/notes/extensions/block-handle"
import { NoteBubbleMenu } from "@/components/notes/extensions/bubble-menu"
import { buildExtensions } from "@/components/notes/extensions"
import { SlashMenu, type SlashMenuState } from "@/components/notes/extensions/slash-command"
import { useNotes } from "@/components/notes/notes-context"
import { NotePageSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { classifyEmbedUrl, isBareUrl } from "@/lib/embed-url"
import { markdownFileName, markdownWithTitle, splitMarkdownTitle } from "@/lib/markdown-file"
import { looksLikeMarkdown } from "@/lib/markdown-paste"
import { NOTE_FIELD, useNoteCollab, type NoteCollab } from "@/lib/note-collab"
import { createAutosave, type Autosave, type SaveStatus } from "@/lib/note-autosave"
import { updateNote, uploadNoteImage, type Note, type NoteSummary } from "@/lib/notes-api"
import { personColor } from "@/lib/person-color"
import { useMe } from "@/lib/queries/bootstrap"
import { useRealtime } from "@/lib/realtime"
import { cn } from "@/lib/utils"

export interface NoteEditorProps {
  hash: string
  note: Note
  /** Title, icon and cover changes, so the tree and crumb keep up without a refetch. */
  onSummaryChange(patch: Partial<NoteSummary>): void
  /** Whether this tab has edits not yet saved, for the other windows' "editing" badge. */
  onEditingChange?(editing: boolean): void
  /** Who else has this page open, shown beside the save status. */
  presence?: React.ReactNode
}

/**
 * One page, open for writing -- with whoever else has it open.
 *
 * The body is the page's shared Yjs document (`useNoteCollab`): until the
 * server's copy has arrived there is nothing true to show, so the page's
 * skeleton stands in for it.
 */
export function NoteEditorImpl(props: NoteEditorProps) {
  const collab = useNoteCollab(props.note.id)
  if (!collab?.synced) return <NotePageSkeleton />
  return <NotePage {...props} collab={collab} />
}

/**
 * The title is a field above the document rather than a node inside it: the
 * tree needs it without parsing the body, and a page's name should not be
 * something a stray backspace can merge into a paragraph. The icon and the
 * cover are fields too, for the same reason, and are saved over REST as they
 * change. The body is the Tiptap document bound to the shared one, which the
 * collab service saves.
 */
function NotePage({
  hash,
  note,
  onSummaryChange,
  onEditingChange,
  presence,
  collab,
}: NoteEditorProps & { collab: NoteCollab }) {
  const { createPage } = useNotes()
  const me = useMe()
  const userId = useRealtime().client?.userId ?? null
  const [status, setStatus] = React.useState<SaveStatus>("saved")
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState(note.title)
  const [icon, setIcon] = React.useState(note.icon)
  const [cover, setCover] = React.useState(note.cover)
  const [slash, setSlash] = React.useState<SlashMenuState | null>(null)
  const [hover, setHover] = React.useState<BlockHover | null>(null)
  const slashKeydown = React.useRef<(event: KeyboardEvent) => boolean>(() => false)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const coverInput = React.useRef<HTMLInputElement>(null)
  const markdownInput = React.useRef<HTMLInputElement>(null)
  const editorRef = React.useRef<Editor | null>(null)
  const pageRef = React.useRef<HTMLDivElement>(null)
  const onSummaryChangeRef = React.useRef(onSummaryChange)
  onSummaryChangeRef.current = onSummaryChange

  const autosave = React.useRef<Autosave | null>(null)

  const editing = status === "dirty" || status === "saving" || collab.unsynced > 0
  React.useEffect(() => onEditingChange?.(editing), [editing, onEditingChange])

  // Created and disposed together, in one effect: React may run the pair
  // more than once for a single mount (strict mode does), and an autosave
  // disposed by one cleanup must not be the one the next mount writes to.
  // Anything still waiting goes out when the page is left -- by navigation,
  // which unmounts this, or by closing the tab, which does not.
  React.useEffect(() => {
    const instance = createAutosave({
      // Short, so another window sees the title nearly as it is typed.
      delayMs: 250,
      updatedAt: note.updatedAt,
      // Sent without the version check: the collab service moves
      // `updatedAt` every time it saves the body, so a check would turn
      // every rename made while someone types into a conflict. Each of
      // these fields is one value, and the last one written stands.
      save: async ({ ifUpdatedAt: _ifUpdatedAt, ...patch }) => {
        const saved = await updateNote(hash, note.id, patch)
        onSummaryChangeRef.current({ updatedAt: saved.updatedAt })
        return saved
      },
      onStatus: (next, error) => {
        setStatus(next)
        setSaveError(next === "error" && error instanceof Error ? error.message : null)
      },
    })
    autosave.current = instance
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!instance.pending) return
      void instance.flush()
      event.preventDefault()
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
      if (autosave.current === instance) autosave.current = null
      void instance.flush().finally(() => instance.dispose())
    }
    // Once per page: the parent keys this component on the note id.
  }, [hash, note.id])

  // The fields, renamed elsewhere and passed down by the workspace. Applied
  // only while nothing here is waiting to go out, so a remote title never
  // lands under a half-typed one. The body needs nothing: it is shared.
  React.useEffect(() => {
    if (autosave.current?.pending) return
    setTitle(note.title)
    setIcon(note.icon)
    setCover(note.cover)
  }, [note.title, note.icon, note.cover])

  const fail = React.useCallback((error: unknown, fallback: string) => {
    setStatus("error")
    setSaveError(error instanceof Error ? error.message : fallback)
  }, [])

  const insertImage = React.useCallback(
    async (file: File | Blob, at?: number) => {
      const editor = editorRef.current
      if (!editor) return
      try {
        const src = await uploadNoteImage(hash, file)
        const chain = editor.chain().focus()
        if (at !== undefined) chain.setTextSelection(at)
        chain.setImage({ src, alt: "name" in file ? file.name : "image" }).run()
      } catch (error) {
        fail(error, "Could not upload the image.")
      }
    },
    [hash, fail],
  )

  /** Fields outside the document: the same write path, mirrored to the tree. */
  const patchField = (patch: Partial<Pick<NoteSummary, "title" | "icon" | "cover">>) => {
    if (patch.title !== undefined) setTitle(patch.title)
    if (patch.icon !== undefined) setIcon(patch.icon)
    if (patch.cover !== undefined) setCover(patch.cover)
    onSummaryChange(patch)
    autosave.current?.update(patch)
  }

  const setCoverFrom = async (file: File) => {
    try {
      patchField({ cover: await uploadNoteImage(hash, file) })
    } catch (error) {
      fail(error, "Could not upload the cover.")
    }
  }

  const slashContext = React.useMemo(
    () => ({
      pickImage: () => fileInput.current?.click(),
      createPage: async () => {
        const page = await createPage(note.id)
        return page.id
      },
    }),
    [createPage, note.id],
  )

  /** Who this tab is to the others: the name and colour of its caret. */
  const caretUser = React.useMemo(
    () => ({ name: me?.name ?? me?.login ?? "Someone", color: personColor(userId ?? "") }),
    [me?.name, me?.login, userId],
  )
  const caretUserRef = React.useRef(caretUser)
  caretUserRef.current = caretUser

  // Built once per page: a new extension list on every render would have
  // Tiptap reconfigure the view -- and its plugins -- on every keystroke.
  const { provider } = collab
  const extensions = React.useMemo(
    () =>
      buildExtensions(
        {
          context: slashContext,
          onState: setSlash,
          onKeyDown: (event) => slashKeydown.current(event),
        },
        { onHover: setHover },
        { provider, field: NOTE_FIELD, user: caretUserRef.current },
      ),
    [slashContext, provider],
  )

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions,
      // No `content`: the body comes from the shared document, which the
      // service seeded from the saved one.
      editable: !collab.readOnly,
      editorProps: {
        attributes: { class: "ucch-note-editor", spellcheck: "true" },
        handleKeyDown: (_view, event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault()
            void autosave.current?.flush()
            return true
          }
          return false
        },
        handlePaste: (view, event) => {
          const files = imageFiles(event.clipboardData)
          if (files.length > 0) {
            for (const file of files) void insertImage(file)
            return true
          }
          const text = event.clipboardData?.getData("text/plain") ?? ""
          const html = event.clipboardData?.getData("text/html") ?? ""
          const editor = editorRef.current
          if (!editor || html) return false
          // A video link on an empty line becomes the video, as in Notion.
          // Other links stay links: a framed page is not always wanted.
          if (isBareUrl(text) && view.state.selection.$from.parent.content.size === 0) {
            const target = classifyEmbedUrl(text)
            if (target && target.provider !== "generic") {
              editor.chain().focus().insertEmbed(target.original).run()
              return true
            }
          }
          // Plain text that is markdown -- from a README, a chat reply, a
          // terminal -- becomes the blocks it describes. Text that came with
          // HTML is left to ProseMirror, which reads the HTML.
          if (!looksLikeMarkdown(text)) return false
          const parsed = markdownManager(editor)?.parse(text)
          if (!parsed) return false
          editor.chain().focus().insertContent(parsed.content ?? []).run()
          return true
        },
        handleDrop: (view, event) => {
          const files = imageFiles(event.dataTransfer)
          if (files.length === 0) return false
          const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
          for (const file of files) void insertImage(file, at)
          return true
        },
      },
    },
    [extensions],
  )
  editorRef.current = editor

  React.useEffect(() => {
    editor?.setEditable(!collab.readOnly)
  }, [editor, collab.readOnly])

  // A name or avatar change made while the page is open.
  React.useEffect(() => {
    if (editor && !editor.isDestroyed) editor.commands.updateUser(caretUser)
  }, [editor, caretUser])
  const band = useBlockBand(editor, pageRef)

  const exportMarkdown = () => {
    if (!editor) return
    downloadText(markdownFileName(title), markdownWithTitle(title, editor.getMarkdown()))
  }

  const copyMarkdown = async () => {
    if (!editor) return
    try {
      await navigator.clipboard.writeText(markdownWithTitle(title, editor.getMarkdown()))
    } catch (error) {
      fail(error, "Could not copy the page.")
    }
  }

  const importMarkdown = async (file: File) => {
    if (!editor) return
    const manager = markdownManager(editor)
    if (!manager) return
    const { title: heading, body } = splitMarkdownTitle(await file.text())
    const parsed = manager.parse(body)
    // Into an empty page whole; onto a page with words, at the end.
    if (editor.isEmpty) editor.commands.setContent(parsed, { emitUpdate: true })
    else editor.chain().focus("end").insertContent(parsed.content ?? []).run()
    if (heading && !title.trim()) patchField({ title: heading })
  }

  return (
    <div ref={pageRef} className="relative">
      {band && <div className="ucch-block-band" style={band} />}
      {cover && (
        <div className="group/cover relative h-40 w-full md:h-56">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cover} alt="" className="size-full object-cover" />
          <div className="absolute right-4 bottom-3 flex gap-1 opacity-0 transition-opacity group-hover/cover:opacity-100 focus-within:opacity-100">
            <Button variant="secondary" size="xs" onClick={() => coverInput.current?.click()}>
              Change cover
            </Button>
            <Button variant="secondary" size="xs" onClick={() => patchField({ cover: null })}>
              <Trash2Icon /> Remove
            </Button>
          </div>
        </div>
      )}
      <div className="group/head mx-auto w-full max-w-[var(--ucch-doc-width,48rem)] px-8 pt-6 pb-32 md:px-12">
        <ReconnectBanner connected={collab.connected} />
        <div className="mb-2 flex h-5 items-center justify-end gap-2">
          {presence}
          <SaveStatusPill
            status={status === "saved" && collab.unsynced > 0 ? "saving" : status}
            error={saveError}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-xs" title="Page options" />}
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={exportMarkdown}>
                <FileDownIcon /> Export as Markdown
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copyMarkdown()}>
                <ClipboardCopyIcon /> Copy as Markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => markdownInput.current?.click()}>
                <FileUpIcon /> Import Markdown…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className={cn("flex items-end gap-2", cover && "-mt-14")}>
          {icon && (
            <EmojiPicker value={icon} onPick={(next) => patchField({ icon: next })}>
              <button
                type="button"
                title="Change icon"
                className="hover:bg-muted -ml-2 flex size-16 items-center justify-center rounded-md text-5xl leading-none"
              >
                {icon}
              </button>
            </EmojiPicker>
          )}
        </div>
        <div
          className={cn(
            "flex h-7 items-center gap-1 opacity-0 transition-opacity group-hover/head:opacity-100 focus-within:opacity-100",
            (icon || cover) && "mt-1",
          )}
        >
          {!icon && (
            <EmojiPicker value={null} onPick={(next) => patchField({ icon: next })}>
              <Button variant="ghost" size="xs" className="text-muted-foreground">
                <SmilePlusIcon /> Add icon
              </Button>
            </EmojiPicker>
          )}
          {!cover && (
            <Button
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => coverInput.current?.click()}
            >
              <ImagePlusIcon /> Add cover
            </Button>
          )}
        </div>
        <input
          value={title}
          placeholder="Untitled"
          aria-label="Page title"
          className="placeholder:text-text-subtle mb-4 w-full rounded-sm bg-transparent text-3xl font-semibold outline-none focus-visible:shadow-[inset_0_-2px_0_var(--focus-ring)]"
          onChange={(event) => patchField({ title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" || (event.key === "ArrowDown" && !event.shiftKey)) {
              event.preventDefault()
              editor?.chain().focus("start").run()
            }
          }}
        />
        {editor && <NoteBubbleMenu editor={editor} />}
        <EditorContent editor={editor} />
        {editor && <BlockHandles editor={editor} hover={hover} hidden={slash !== null} />}
        <SlashMenu state={slash} keydown={slashKeydown} />
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            for (const file of Array.from(event.target.files ?? [])) void insertImage(file)
            event.target.value = ""
          }}
        />
        <input
          ref={coverInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void setCoverFrom(file)
            event.target.value = ""
          }}
        />
        <input
          ref={markdownInput}
          type="file"
          accept=".md,.markdown,.txt,text/markdown,text/plain"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void importMarkdown(file)
            event.target.value = ""
          }}
        />
      </div>
    </div>
  )
}

/** The Markdown extension's parser, which the paste and import paths share. */
function markdownManager(editor: Editor): { parse(md: string): JSONContent } | null {
  return (
    (editor.storage as { markdown?: { manager?: { parse(md: string): JSONContent } } }).markdown
      ?.manager ?? null
  )
}

/** Hands the browser a file to save. */
function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** The image files in a paste or a drop, and nothing else. */
function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  return Array.from(data.files).filter((file) => file.type.startsWith("image/"))
}

/**
 * Says so when the page's connection has been down for more than a moment.
 * Typing goes on: the edits stay in the shared document and are sent when
 * the connection is back, so this is a banner, not a lock.
 */
function ReconnectBanner({ connected }: { connected: boolean }) {
  const [down, setDown] = React.useState(false)
  React.useEffect(() => {
    if (connected) {
      setDown(false)
      return
    }
    const timer = window.setTimeout(() => setDown(true), 2000)
    return () => window.clearTimeout(timer)
  }, [connected])
  if (!down) return null
  return (
    <div
      role="status"
      className="bg-muted text-muted-foreground mb-3 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
    >
      <WifiOffIcon className="size-3.5 shrink-0" />
      Offline — reconnecting. Your edits are kept here and will sync when the connection is back.
    </div>
  )
}

function SaveStatusPill({ status, error }: { status: SaveStatus; error: string | null }) {
  const label =
    status === "saving"
      ? "Saving…"
      : status === "dirty"
        ? "Unsaved changes"
        : status === "saved"
          ? "Saved"
          : status === "conflict"
            ? "Changed elsewhere"
            : "Could not save"
  const Icon = status === "saving" ? Loader2Icon : status === "saved" ? CheckIcon : AlertTriangleIcon
  const trouble = status === "error" || status === "conflict"
  return (
    <span
      title={error ?? undefined}
      className={cn(
        "flex items-center gap-1 text-[11px]",
        trouble ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className={cn("size-3", status === "saving" && "animate-spin")} />
      {label}
    </span>
  )
}
