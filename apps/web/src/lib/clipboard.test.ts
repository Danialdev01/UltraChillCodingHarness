import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard.js";

afterEach(() => vi.unstubAllGlobals());

/** A document stub with only the parts `legacyCopy` touches. */
function stubDocument(execCommand: () => boolean) {
  const appended: { value: string; removed: boolean }[] = [];
  vi.stubGlobal("document", {
    body: {
      appendChild(node: { value: string }) {
        appended.push(node as never);
      },
    },
    createElement: () => {
      const element = {
        value: "",
        readOnly: false,
        removed: false,
        style: {} as Record<string, string>,
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
        remove() {
          this.removed = true;
        },
      };
      return element;
    },
    execCommand,
  });
  return appended;
}

describe("copying", () => {
  it("uses the clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    expect(await copyText("const a = 1")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("const a = 1");
  });

  it("falls back on a plain-HTTP origin, where the API is not there", async () => {
    // Exactly the setup this harness documents: opened at http://host:3000
    // from another machine. `navigator.clipboard` is undefined outside a
    // secure context, and a button that only called it would be dead there.
    vi.stubGlobal("navigator", {});
    const appended = stubDocument(() => true);

    expect(await copyText("fallback")).toBe(true);
    expect(appended[0]!.value).toBe("fallback");
  });

  it("falls back when the API is present but refuses", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    const appended = stubDocument(() => true);

    expect(await copyText("denied then copied")).toBe(true);
    expect(appended).toHaveLength(1);
  });

  it("reports failure rather than claiming a copy that did not happen", async () => {
    vi.stubGlobal("navigator", {});
    stubDocument(() => false);
    expect(await copyText("nope")).toBe(false);
  });

  it("cleans up the element it borrowed, even when the copy throws", async () => {
    vi.stubGlobal("navigator", {});
    const appended = stubDocument(() => {
      throw new Error("execCommand exploded");
    });

    expect(await copyText("boom")).toBe(false);
    expect(appended[0]!.removed).toBe(true);
  });

  it("does not throw where there is no document at all", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);
    expect(await copyText("nowhere")).toBe(false);
  });
});
