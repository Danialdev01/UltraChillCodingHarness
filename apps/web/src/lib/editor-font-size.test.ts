import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDITOR_FONT_SIZE_EVENT,
  EDITOR_FONT_SIZE_STORAGE_KEY,
  parseEditorFontSize,
  readEditorFontSize,
  watchEditorFontSize,
  writeEditorFontSize,
} from "./editor-font-size.js";

function store(impl?: Partial<Storage>) {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    ...impl,
  });
  return data;
}

/** No DOM in these tests: see editor-keybindings.test.ts. */
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

describe("parsing a font size", () => {
  it("accepts a number or a numeric string, rounded to whole pixels", () => {
    expect(parseEditorFontSize(14)).toBe(14);
    expect(parseEditorFontSize("14")).toBe(14);
    expect(parseEditorFontSize(13.6)).toBe(14);
  });

  it("clamps to the readable range", () => {
    expect(parseEditorFontSize(2)).toBe(8);
    expect(parseEditorFontSize(200)).toBe(32);
  });

  it("rejects what is not a number", () => {
    expect(parseEditorFontSize("big")).toBeNull();
    expect(parseEditorFontSize(null)).toBeNull();
    expect(parseEditorFontSize(undefined)).toBeNull();
    expect(parseEditorFontSize(NaN)).toBeNull();
  });
});

describe("the editor's font size", () => {
  it("defaults to 12 when nothing has been chosen", () => {
    store();
    expect(readEditorFontSize()).toBe(12);
  });

  it("comes back as written, clamped", () => {
    store();
    expect(writeEditorFontSize(16)).toBe(16);
    expect(readEditorFontSize()).toBe(16);
    expect(writeEditorFontSize(99)).toBe(32);
    expect(readEditorFontSize()).toBe(32);
  });

  it("falls back to the default on a value that is not a size", () => {
    const data = store();
    data.set(EDITOR_FONT_SIZE_STORAGE_KEY, "large");
    expect(readEditorFontSize()).toBe(12);
  });

  it("survives storage that throws", () => {
    store({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => writeEditorFontSize(16)).not.toThrow();
    expect(readEditorFontSize()).toBe(12);
  });

  it("tells a watcher about a change made in this tab", () => {
    store();
    dom();
    const seen: number[] = [];
    const stop = watchEditorFontSize((v) => seen.push(v));
    writeEditorFontSize(14);
    stop();
    writeEditorFontSize(18);
    expect(seen).toEqual([14]);
  });

  it("tells a watcher about a change made in another tab", () => {
    store();
    const { win } = dom();
    const seen: number[] = [];
    const stop = watchEditorFontSize((v) => seen.push(v));
    win.dispatchEvent(storageEvent(EDITOR_FONT_SIZE_STORAGE_KEY, "15"));
    win.dispatchEvent(storageEvent("ucch:theme", "x"));
    win.dispatchEvent(storageEvent(EDITOR_FONT_SIZE_STORAGE_KEY, null));
    stop();
    expect(seen).toEqual([15, 12]);
  });

  it("ignores an event carrying something that is not a size", () => {
    store();
    const { doc } = dom();
    const seen: number[] = [];
    const stop = watchEditorFontSize((v) => seen.push(v));
    doc.dispatchEvent(new CustomEvent(EDITOR_FONT_SIZE_EVENT, { detail: "huge" }));
    stop();
    expect(seen).toEqual([]);
  });
});
