/**
 * What a widget's `sendPrompt(text)` does: put the text in the composer for
 * the reader to send (the default -- a page in an answer must not speak for
 * them), or send it at once.
 *
 * A per-browser preference, like the chat view mode: kept in `localStorage`,
 * announced on the document when it changes, and every access guarded.
 */

import * as React from "react";

export type WidgetPromptMode = "composer" | "send";

export const WIDGET_PROMPT_MODES = ["composer", "send"] as const satisfies readonly WidgetPromptMode[];
export const DEFAULT_WIDGET_PROMPT_MODE: WidgetPromptMode = "composer";
export const WIDGET_PROMPT_MODE_STORAGE_KEY = "ucch:widget-prompt-mode";
const EVENT = "ucch:widget-prompt-mode";

export function parseWidgetPromptMode(value: unknown): WidgetPromptMode | null {
  return typeof value === "string" && (WIDGET_PROMPT_MODES as readonly string[]).includes(value)
    ? (value as WidgetPromptMode)
    : null;
}

export function readWidgetPromptMode(): WidgetPromptMode {
  try {
    return (
      parseWidgetPromptMode(globalThis.localStorage?.getItem(WIDGET_PROMPT_MODE_STORAGE_KEY)) ??
      DEFAULT_WIDGET_PROMPT_MODE
    );
  } catch {
    return DEFAULT_WIDGET_PROMPT_MODE;
  }
}

export function writeWidgetPromptMode(value: WidgetPromptMode): void {
  try {
    globalThis.localStorage?.setItem(WIDGET_PROMPT_MODE_STORAGE_KEY, value);
  } catch {
    /* not remembered, still applied in this tab */
  }
  globalThis.document?.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

export function watchWidgetPromptMode(listener: (value: WidgetPromptMode) => void): () => void {
  const doc = globalThis.document;
  if (!doc) return () => {};
  function onLocal(event: Event) {
    const value = parseWidgetPromptMode((event as CustomEvent<unknown>).detail);
    if (value !== null) listener(value);
  }
  function onStorage(event: StorageEvent) {
    if (event.key !== WIDGET_PROMPT_MODE_STORAGE_KEY) return;
    listener(parseWidgetPromptMode(event.newValue) ?? DEFAULT_WIDGET_PROMPT_MODE);
  }
  doc.addEventListener(EVENT, onLocal);
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    doc.removeEventListener(EVENT, onLocal);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

export function useWidgetPromptMode(): WidgetPromptMode {
  const [mode, setMode] = React.useState<WidgetPromptMode>(DEFAULT_WIDGET_PROMPT_MODE);
  React.useEffect(() => {
    setMode(readWidgetPromptMode());
    return watchWidgetPromptMode(setMode);
  }, []);
  return mode;
}
