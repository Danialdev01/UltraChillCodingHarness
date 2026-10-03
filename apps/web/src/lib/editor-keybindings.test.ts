import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_KEYBINDINGS_EVENT,
  EDITOR_KEYBINDINGS_STORAGE_KEY,
  parseEditorKeybindings,
  readEditorKeybindings,
  watchEditorKeybindings,
  writeEditorKeybindings,
} from "./editor-keybindings.js";

function store(impl?: Partial<Storage>) {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    ...impl,
  });
  return data;
}

/**
 * The tests run without a DOM: `document` is stood in for by an event target,
 * and the window's listener methods -- which the module reaches through
 * `globalThis` -- by a second one, so a `storage` event can be dispatched.
 */
function dom() {
  const doc = new EventTarget();
  const win = new EventTarget();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("addEventListener", win.addEventListener.bind(win));
  vi.stubGlobal("removeEventListener", win.removeEventListener.bind(win));
  return { doc, win };
}

function storageEvent(key: string, newValue: string | null): Event {
  return Object.assign(new Event("storage"), { key, newValue });
}

afterEach(() => vi.unstubAllGlobals());

describe("the editor's keybindings", () => {
  it("default to on when nothing has been chosen", () => {
    store();
    expect(readEditorKeybindings()).toBe("vim-emacs");
  });

  it("come back as written", () => {
    store();
    writeEditorKeybindings("none");
    expect(readEditorKeybindings()).toBe("none");
    writeEditorKeybindings("vim-emacs");
    expect(readEditorKeybindings()).toBe("vim-emacs");
  });

  it("fall back to on for a value that is not a choice", () => {
    const data = store();
    data.set(EDITOR_KEYBINDINGS_STORAGE_KEY, "nano");
    expect(readEditorKeybindings()).toBe("vim-emacs");
  });

  it("read the old separate vim and emacs choices as the one layer", () => {
    const data = store();
    data.set(EDITOR_KEYBINDINGS_STORAGE_KEY, "vim");
    expect(readEditorKeybindings()).toBe("vim-emacs");
    data.set(EDITOR_KEYBINDINGS_STORAGE_KEY, "emacs");
    expect(readEditorKeybindings()).toBe("vim-emacs");
    expect(parseEditorKeybindings("none")).toBe("none");
    expect(parseEditorKeybindings("nano")).toBeNull();
  });

  it("survive storage that throws", () => {
    store({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => writeEditorKeybindings("none")).not.toThrow();
    expect(readEditorKeybindings()).toBe("vim-emacs");
  });

  it("tell a watcher about a change made in this tab", () => {
    store();
    dom();
    const seen: string[] = [];
    const stop = watchEditorKeybindings((v) => seen.push(v));
    writeEditorKeybindings("none");
    stop();
    writeEditorKeybindings("vim-emacs");
    expect(seen).toEqual(["none"]);
  });

  it("tell a watcher about a change made in another tab", () => {
    store();
    const { win } = dom();
    const seen: string[] = [];
    const stop = watchEditorKeybindings((v) => seen.push(v));
    win.dispatchEvent(storageEvent(EDITOR_KEYBINDINGS_STORAGE_KEY, "none"));
    win.dispatchEvent(storageEvent("ucch:theme", "x"));
    // Cleared elsewhere: back to the default, not stuck on the last value.
    win.dispatchEvent(storageEvent(EDITOR_KEYBINDINGS_STORAGE_KEY, null));
    stop();
    win.dispatchEvent(storageEvent(EDITOR_KEYBINDINGS_STORAGE_KEY, "none"));
    expect(seen).toEqual(["none", "vim-emacs"]);
  });

  it("ignore an event carrying something that is not a choice", () => {
    store();
    const { doc } = dom();
    const seen: string[] = [];
    const stop = watchEditorKeybindings((v) => seen.push(v));
    doc.dispatchEvent(new CustomEvent(EDITOR_KEYBINDINGS_EVENT, { detail: 42 }));
    stop();
    expect(seen).toEqual([]);
  });
});
