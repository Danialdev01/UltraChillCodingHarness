import { describe, expect, it } from "vitest";
import { ComposerStore } from "./composer.js";

const THREAD = "44444444-4444-4444-4444-444444444444";
const A = { userId: "11111111-1111-1111-1111-111111111111", clientId: "tab-a" };
const B = { userId: "11111111-1111-1111-1111-111111111111", clientId: "tab-b" };
const draft = (text: string) => ({ text, attachments: [], reference: null });

describe("ComposerStore", () => {
  it("starts empty at rev 0", () => {
    const store = new ComposerStore();
    expect(store.get(THREAD)).toEqual({ rev: 0, draft: draft(""), origin: null });
  });

  it("accepts an update made against the current rev and moves the rev on", () => {
    const store = new ComposerStore();
    const first = store.update(THREAD, 0, draft("h"), A);
    expect(first.ok).toBe(true);
    const second = store.update(THREAD, first.state.rev, draft("he"), A);
    expect(second.ok).toBe(true);
    expect(second.state.rev).toBeGreaterThan(first.state.rev);
    expect(store.get(THREAD).draft.text).toBe("he");
  });

  it("refuses an update typed against an older rev, and returns what won", () => {
    const store = new ComposerStore();
    const a = store.update(THREAD, 0, draft("from a"), A);
    const b = store.update(THREAD, 0, draft("from b"), B);
    expect(b.ok).toBe(false);
    expect(b.state).toEqual(a.state);
    expect(store.get(THREAD).draft.text).toBe("from a");
  });

  it("clears without a rev check, and the next update must be made against the clear", () => {
    const store = new ComposerStore();
    const typed = store.update(THREAD, 0, draft("question"), A);
    const cleared = store.clear(THREAD);
    expect(cleared.draft.text).toBe("");
    expect(cleared.origin).toBeNull();
    expect(store.update(THREAD, typed.state.rev, draft("stale"), A).ok).toBe(false);
    expect(store.update(THREAD, cleared.rev, draft("next"), A).ok).toBe(true);
  });

  it("never reissues a rev across threads", () => {
    const store = new ComposerStore();
    const one = store.update(THREAD, 0, draft("x"), A);
    const other = store.update("55555555-5555-5555-5555-555555555555", 0, draft("y"), A);
    expect(other.state.rev).not.toBe(one.state.rev);
  });
});
