/**
 * Whether the file editor runs its modal keybindings -- the vim engine with
 * emacs chords layered on it, in the manner of Doom Emacs -- or plain
 * CodeMirror ones. One layer, on or off: vim and emacs are not alternatives
 * here but two halves of the same set of bindings.
 *
 * A per-browser preference like the theme and the last model, not a fact
 * about the account: it is how this keyboard likes to be driven. Kept in
 * `localStorage` so the setting survives a reload, and announced on the
 * document when it changes so an editor that is already mounted can swap its
 * keymap without being torn down and rebuilt around the file it is showing.
 *
 * Every access is guarded: `localStorage` throws outright in a private window
 * with site data blocked, and a preference is never worth an exception in the
 * editor.
 */

export type EditorKeybindings = "vim-emacs" | "none";

export const EDITOR_KEYBINDINGS = ["vim-emacs", "none"] as const satisfies readonly EditorKeybindings[];

/** What the editor shipped with before this was a choice. */
export const DEFAULT_EDITOR_KEYBINDINGS: EditorKeybindings = "vim-emacs";

/** Where the choice lives between visits. */
export const EDITOR_KEYBINDINGS_STORAGE_KEY = "ucch:editor-keybindings";

/** Dispatched on `document` when the choice changes, with the new value as `detail`. */
export const EDITOR_KEYBINDINGS_EVENT = "ucch:editor-keybindings";

export function isEditorKeybindings(value: unknown): value is EditorKeybindings {
  return typeof value === "string" && (EDITOR_KEYBINDINGS as readonly string[]).includes(value);
}

/**
 * A stored value as a choice, or null when it is not one.
 *
 * "vim" and "emacs" were briefly separate choices; either now means the one
 * layer is on, so a browser that picked one keeps its modal editing.
 */
export function parseEditorKeybindings(value: unknown): EditorKeybindings | null {
  if (value === "vim" || value === "emacs") return "vim-emacs";
  return isEditorKeybindings(value) ? value : null;
}

export function readEditorKeybindings(): EditorKeybindings {
  try {
    return (
      parseEditorKeybindings(globalThis.localStorage?.getItem(EDITOR_KEYBINDINGS_STORAGE_KEY)) ??
      DEFAULT_EDITOR_KEYBINDINGS
    );
  } catch {
    return DEFAULT_EDITOR_KEYBINDINGS;
  }
}

export function writeEditorKeybindings(value: EditorKeybindings): void {
  try {
    globalThis.localStorage?.setItem(EDITOR_KEYBINDINGS_STORAGE_KEY, value);
  } catch {
    /* nothing to do: the choice simply is not remembered */
  }
  globalThis.document?.dispatchEvent(new CustomEvent(EDITOR_KEYBINDINGS_EVENT, { detail: value }));
}

/**
 * Calls `listener` with the new value whenever the choice changes -- from the
 * settings page in this tab, or from another tab of the same browser through
 * the `storage` event. Returns the unsubscribe.
 */
export function watchEditorKeybindings(listener: (value: EditorKeybindings) => void): () => void {
  const doc = globalThis.document;
  if (!doc) return () => {};
  function onLocal(event: Event) {
    const value = parseEditorKeybindings((event as CustomEvent<unknown>).detail);
    if (value !== null) listener(value);
  }
  function onStorage(event: StorageEvent) {
    if (event.key !== EDITOR_KEYBINDINGS_STORAGE_KEY) return;
    listener(parseEditorKeybindings(event.newValue) ?? DEFAULT_EDITOR_KEYBINDINGS);
  }
  doc.addEventListener(EDITOR_KEYBINDINGS_EVENT, onLocal);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    doc.removeEventListener(EDITOR_KEYBINDINGS_EVENT, onLocal);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}
