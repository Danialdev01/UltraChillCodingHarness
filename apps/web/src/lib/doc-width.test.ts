import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DOC_WIDTH_EVENT,
  DOC_WIDTH_STORAGE_KEY,
  docMaxWidth,
  parseDocWidth,
  readDocWidth,
  watchDocWidth,
  writeDocWidth,
} from "./doc-width.js";

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

afterEach(() => vi.unstubAllGlobals());

describe("parsing a width", () => {
  it("accepts the named widths and nothing else", () => {
    expect(parseDocWidth("wide")).toBe("wide");
    expect(parseDocWidth("full")).toBe("full");
    expect(parseDocWidth("huge")).toBeNull();
    expect(parseDocWidth(null)).toBeNull();
  });

  it("keeps the default at the page's original width", () => {
    expect(docMaxWidth("default")).toBe("48rem");
    expect(docMaxWidth("full")).toBe("100%");
  });
});

describe("storing a width", () => {
  it("reads the default when nothing, or nonsense, is stored", () => {
    const data = store();
    expect(readDocWidth()).toBe("default");
    data.set(DOC_WIDTH_STORAGE_KEY, "enormous");
    expect(readDocWidth()).toBe("default");
  });

  it("round-trips a choice", () => {
    store();
    dom();
    expect(writeDocWidth("narrow")).toBe("narrow");
    expect(readDocWidth()).toBe("narrow");
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
    dom();
    expect(readDocWidth()).toBe("default");
    expect(writeDocWidth("wide")).toBe("wide");
  });
});

describe("watching a width", () => {
  it("hears a change from this tab and from another", () => {
    store();
    const { doc, win } = dom();
    const seen: string[] = [];
    const stop = watchDocWidth((w) => seen.push(w));
    doc.dispatchEvent(new CustomEvent(DOC_WIDTH_EVENT, { detail: "wide" }));
    win.dispatchEvent(Object.assign(new Event("storage"), { key: DOC_WIDTH_STORAGE_KEY, newValue: "full" }));
    win.dispatchEvent(Object.assign(new Event("storage"), { key: "other", newValue: "narrow" }));
    stop();
    doc.dispatchEvent(new CustomEvent(DOC_WIDTH_EVENT, { detail: "narrow" }));
    expect(seen).toEqual(["wide", "full"]);
  });
});
