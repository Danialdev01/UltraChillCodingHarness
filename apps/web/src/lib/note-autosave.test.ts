import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAutosave, type SaveStatus } from "./note-autosave";

function harness(overrides: { failWith?: unknown } = {}) {
  const calls: unknown[] = [];
  const statuses: SaveStatus[] = [];
  let tick = 0;
  let failWith = overrides.failWith;
  const autosave = createAutosave({
    delayMs: 800,
    updatedAt: "t0",
    save: async (patch) => {
      calls.push(patch);
      await Promise.resolve();
      if (failWith) {
        const error = failWith;
        failWith = undefined;
        throw error;
      }
      return { updatedAt: `t${++tick}` };
    },
    onStatus: (s) => statuses.push(s),
    isConflict: (e) => e === "conflict",
  });
  return { autosave, calls, statuses };
}

describe("createAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces edits within the window into one save", async () => {
    const { autosave, calls } = harness();
    autosave.update({ title: "a" });
    autosave.update({ title: "ab" });
    autosave.update({ content: { type: "doc" } });
    expect(autosave.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(799);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ title: "ab", content: { type: "doc" }, ifUpdatedAt: "t0" }]);
    expect(autosave.pending).toBe(false);
    expect(autosave.updatedAt).toBe("t1");
  });

  it("never runs two saves at once; an edit mid-save goes next", async () => {
    const { autosave, calls, statuses } = harness();
    autosave.update({ title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    // The first save has started (awaiting its microtask) -- edit now.
    autosave.update({ title: "b" });
    await vi.advanceTimersByTimeAsync(800);
    expect(calls.map((c) => (c as { title: string }).title)).toEqual(["a", "b"]);
    expect((calls[1] as { ifUpdatedAt: string }).ifUpdatedAt).toBe("t1");
    expect(statuses.at(-1)).toBe("saved");
  });

  it("keeps a failed edit pending and reports the error", async () => {
    const { autosave, calls, statuses } = harness({ failWith: new Error("down") });
    autosave.update({ title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    expect(statuses.at(-1)).toBe("error");
    expect(autosave.pending).toBe(true);
    await autosave.flush();
    expect(calls).toHaveLength(2);
    expect(statuses.at(-1)).toBe("saved");
  });

  it("reports a stale write as a conflict and drops the refused edit", async () => {
    const { autosave, calls, statuses } = harness({ failWith: "conflict" });
    autosave.update({ title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    expect(statuses.at(-1)).toBe("conflict");
    // Reverted, not retried: the other version stands.
    expect(autosave.pending).toBe(false);
    await autosave.flush();
    expect(calls).toHaveLength(1);
  });

  it("saves the next edit against the version adopted after a conflict", async () => {
    const { autosave, calls } = harness({ failWith: "conflict" });
    autosave.update({ title: "a" });
    await vi.advanceTimersByTimeAsync(800);
    // The editor adopts the winning version, then the person types again.
    autosave.accept("theirs");
    autosave.update({ title: "ab" });
    await autosave.flush();
    expect((calls.at(-1) as { ifUpdatedAt: string }).ifUpdatedAt).toBe("theirs");
  });

  it("flush saves immediately and resolves at once when idle", async () => {
    const { autosave, calls } = harness();
    await autosave.flush();
    expect(calls).toHaveLength(0);
    autosave.update({ title: "a" });
    await autosave.flush();
    expect(calls).toHaveLength(1);
    expect(autosave.pending).toBe(false);
  });

  it("writes against an accepted version", async () => {
    const { autosave, calls } = harness();
    autosave.accept("remote");
    autosave.update({ title: "a" });
    await autosave.flush();
    expect((calls[0] as { ifUpdatedAt: string }).ifUpdatedAt).toBe("remote");
  });

  it("does nothing after dispose", async () => {
    const { autosave, calls } = harness();
    autosave.update({ title: "a" });
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toHaveLength(0);
  });
});
