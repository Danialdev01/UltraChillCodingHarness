"use client"

import * as React from "react"
import { KeyboardIcon } from "lucide-react"

import {
  DEFAULT_EDITOR_KEYBINDINGS,
  readEditorKeybindings,
  watchEditorKeybindings,
  writeEditorKeybindings,
  type EditorKeybindings,
} from "@/lib/editor-keybindings"
import { cn } from "@/lib/utils"

const CHOICES: { id: EditorKeybindings; label: string; hint: string }[] = [
  {
    id: "vim-emacs",
    label: "Vim + Emacs",
    hint: "Vim modes, motions and the : command line, with emacs chords and Doom's space leader on top: SPC s s searches the file, SPC . finds one, SPC , switches.",
  },
  { id: "none", label: "Off", hint: "Plain editing: arrows, shift-select, ctrl-Z." },
]

/**
 * Whether the file editor runs its modal keybindings.
 *
 * One switch rather than a vim/emacs choice: the two are a single layer here,
 * vim's modal grammar with emacs chords mapped onto it, and turning one off
 * without the other is not a configuration that exists.
 *
 * A browser preference rather than an account one, like the theme: it is
 * about the keyboard in front of you, so it is kept in `localStorage` and
 * takes effect at once in any file that is open -- there is nothing to save
 * and no request to wait on.
 *
 * Read after mount rather than during render, so the first paint matches what
 * the server produced and nothing is hydrated against a value it never had.
 */
export function KeybindingSettings() {
  const [choice, setChoice] = React.useState<EditorKeybindings>(DEFAULT_EDITOR_KEYBINDINGS)

  React.useEffect(() => {
    setChoice(readEditorKeybindings())
    return watchEditorKeybindings(setChoice)
  }, [])

  function choose(value: EditorKeybindings) {
    setChoice(value)
    writeEditorKeybindings(value)
  }

  const current = CHOICES.find((c) => c.id === choice)

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <KeyboardIcon className="text-muted-foreground size-4" />
        Editor keybindings
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Whether the code editor in a project&apos;s file view runs its modal keybindings.
        Ctrl-S saves either way. Applies to this browser only.
      </p>

      <div
        role="radiogroup"
        aria-label="Editor keybindings"
        className="bg-muted/40 mt-4 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
      >
        {CHOICES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={choice === id}
            onClick={() => choose(id)}
            className={cn(
              "h-7 rounded-md px-3 text-xs transition-colors",
              choice === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-muted-foreground mt-3 text-sm">{current?.hint}</p>
    </section>
  )
}
