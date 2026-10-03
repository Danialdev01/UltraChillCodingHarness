import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerDraft } from "@ucch/protocol";
import { createComposerSync } from "./composer-sync";

const d = (text: string): ComposerDraft => ({ text, attachments: [], reference: null });

/** A fake server holding one draft, answering like the real one. */
function harness() {
  let rev = 0;
  let serverDraft = d("");
  const sent: Array<{ baseRev: number; text: string }> = [];
  const applied: string[] = [];
  let reverted = 0;

  const sync = createComposerSync({
    delayMs: 100,
    send: async (baseRev, draft) => {
      sent.push({ baseRev, text: draft.text });
      await Promise.resolve();
      if (baseRev !== rev) {
        // The server pushes what won before refusing.
        sync.remote({ rev, draft: serverDraft, own: false });
        throw "conflict";
      }
      rev += 1;
      serverDraft = draft;
      sync.remote({ rev, draft, own: true });
    },
    isConflict: (e) => e === "conflict",
    apply: (draft) => applied.push(draft.text),
    onReverted: () => reverted++,
  });

  /** Another window writing straight to the server. */
  const other = (text: string) => {
    rev += 1;
    serverDraft = d(text);
    sync.remote({ rev, draft: serverDraft, own: false });
  };

  return { sync, sent, applied, other, reverted: () => reverted, server: () => serverDraft.text };
}

describe("createComposerSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces typing into one update after the pause", async () => {
    const h = harness();
    h.sync.local(d("h"));
    h.sync.local(d("he"));
    h.sync.local(d("hey"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent).toEqual([{ baseRev: 0, text: "hey" }]);
    expect(h.server()).toBe("hey");
  });

  it("builds the next update on its own echoed rev", async () => {
    const h = harness();
    h.sync.local(d("a"));
    await vi.advanceTimersByTimeAsync(100);
    h.sync.local(d("ab"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent.map((s) => s.baseRev)).toEqual([0, 1]);
    expect(h.server()).toBe("ab");
    expect(h.reverted()).toBe(0);
  });

  it("shows another window's draft at once when nothing is unsent here", () => {
    const h = harness();
    h.other("from the other window");
    expect(h.applied).toEqual(["from the other window"]);
  });

  it("refuses this window's edit when the other wrote first, and reverts to theirs", async () => {
    const h = harness();
    h.sync.local(d("mine"));
    h.other("theirs"); // arrives while "mine" is waiting to go
    expect(h.applied).toEqual([]); // held, not shown over the typing
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent).toEqual([{ baseRev: 0, text: "mine" }]);
    expect(h.server()).toBe("theirs");
    expect(h.applied).toEqual(["theirs"]);
    expect(h.reverted()).toBe(1);
  });

  it("types on normally after a revert", async () => {
    const h = harness();
    h.sync.local(d("mine"));
    h.other("theirs");
    await vi.advanceTimersByTimeAsync(100);
    h.sync.local(d("theirs, and more"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.server()).toBe("theirs, and more");
  });

  it("ignores the box being set to what it already is", async () => {
    const h = harness();
    h.other("same");
    h.sync.local(d("same"));
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent).toEqual([]);
  });

  it("discards what is unsent when the message goes", async () => {
    const h = harness();
    h.sync.local(d("question"));
    h.sync.discard();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent).toEqual([]);
    expect(h.sync.pending).toBe(false);
  });
});
