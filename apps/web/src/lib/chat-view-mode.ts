/**
 * How an assistant turn is laid out in the chat.
 *
 * - "default": prose up front, every thought and tool call folded into one
 *   "Thought" dropdown.
 * - "transcript": the CLI look -- every step inline and in order, file edits
 *   as diffs, shell commands with their output and exit code. For debugging
 *   a run, or following along while it works.
 *
 * A per-browser preference, like the editor keybindings: kept in
 * `localStorage`, announced on the document when it changes so a mounted chat
 * re-renders at once, and every access guarded.
 */

import * as React from "react";

export type ChatViewMode = "default" | "transcript";

export const CHAT_VIEW_MODES = ["default", "transcript"] as const satisfies readonly ChatViewMode[];

export const DEFAULT_CHAT_VIEW_MODE: ChatViewMode = "default";

export const CHAT_VIEW_MODE_STORAGE_KEY = "ucch:chat-view-mode";

/** Dispatched on `document` when the choice changes, with the new value as `detail`. */
export const CHAT_VIEW_MODE_EVENT = "ucch:chat-view-mode";

export function parseChatViewMode(value: unknown): ChatViewMode | null {
  return typeof value === "string" && (CHAT_VIEW_MODES as readonly string[]).includes(value)
    ? (value as ChatViewMode)
    : null;
}

export function readChatViewMode(): ChatViewMode {
  try {
    return parseChatViewMode(globalThis.localStorage?.getItem(CHAT_VIEW_MODE_STORAGE_KEY)) ?? DEFAULT_CHAT_VIEW_MODE;
  } catch {
    return DEFAULT_CHAT_VIEW_MODE;
  }
}

export function writeChatViewMode(value: ChatViewMode): void {
  try {
    globalThis.localStorage?.setItem(CHAT_VIEW_MODE_STORAGE_KEY, value);
  } catch {
    /* not remembered, still applied in this tab */
  }
  globalThis.document?.dispatchEvent(new CustomEvent(CHAT_VIEW_MODE_EVENT, { detail: value }));
}

/** Calls `listener` whenever the choice changes, in this tab or another. Returns the unsubscribe. */
export function watchChatViewMode(listener: (value: ChatViewMode) => void): () => void {
  const doc = globalThis.document;
  if (!doc) return () => {};
  function onLocal(event: Event) {
    const value = parseChatViewMode((event as CustomEvent<unknown>).detail);
    if (value !== null) listener(value);
  }
  function onStorage(event: StorageEvent) {
    if (event.key !== CHAT_VIEW_MODE_STORAGE_KEY) return;
    listener(parseChatViewMode(event.newValue) ?? DEFAULT_CHAT_VIEW_MODE);
  }
  doc.addEventListener(CHAT_VIEW_MODE_EVENT, onLocal);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    doc.removeEventListener(CHAT_VIEW_MODE_EVENT, onLocal);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/**
 * The current mode, read after mount so the first paint matches the server
 * render, and kept live as it changes.
 */
export function useChatViewMode(): ChatViewMode {
  const [mode, setMode] = React.useState<ChatViewMode>(DEFAULT_CHAT_VIEW_MODE);
  React.useEffect(() => {
    setMode(readChatViewMode());
    return watchChatViewMode(setMode);
  }, []);
  return mode;
}
