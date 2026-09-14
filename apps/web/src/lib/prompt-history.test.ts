import { describe, expect, it } from "vitest";
import { historyDirection, idleCursor, step, type HistoryCursor } from "./prompt-history.js";

const entries = ["first", "second", "third"];

describe("stepping back through prompts", () => {
  it("recalls the newest first, then older, and stops at the oldest", () => {
    const a = step(idleCursor, "back", entries, "typing")!;
    expect(a.text).toBe("third");
    const b = step(a.cursor, "back", entries, a.text)!;
    expect(b.text).toBe("second");
    const c = step(b.cursor, "back", entries, b.text)!;
    expect(c.text).toBe("first");
    expect(step(c.cursor, "back", entries, c.text)).toBeNull();
  });

  it("comes forward again and restores the draft past the newest", () => {
    const a = step(idleCursor, "back", entries, "typing")!;
    const b = step(a.cursor, "back", entries, a.text)!;
    const c = step(b.cursor, "forward", entries, b.text)!;
    expect(c.text).toBe("third");
    const d = step(c.cursor, "forward", entries, c.text)!;
    expect(d).toEqual({ cursor: idleCursor, text: "typing" });
    expect(step(d.cursor, "forward", entries, d.text)).toBeNull();
  });

  it("skips an entry identical to what is shown", () => {
    const repeated = ["a", "b", "b"];
    const a = step(idleCursor, "back", repeated, "")!;
    expect(a.text).toBe("b");
    expect(step(a.cursor, "back", repeated, a.text)!.text).toBe("a");
  });

  it("does nothing with no history", () => {
    expect(step(idleCursor, "back", [], "x")).toBeNull();
    expect(step(idleCursor, "forward", [], "x")).toBeNull();
  });

  it("keeps the original draft across several steps", () => {
    let cursor: HistoryCursor = idleCursor;
    let text = "draft";
    for (let i = 0; i < 3; i++) ({ cursor, text } = step(cursor, "back", entries, text)!);
    for (let i = 0; i < 3; i++) ({ cursor, text } = step(cursor, "forward", entries, text)!);
    expect(text).toBe("draft");
  });
});

describe("historyDirection", () => {
  const key = (key: string, mods: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  });

  it("is alt with an arrow, and nothing else", () => {
    expect(historyDirection(key("ArrowUp", { altKey: true }))).toBe("back");
    expect(historyDirection(key("ArrowDown", { altKey: true }))).toBe("forward");
    expect(historyDirection(key("ArrowUp"))).toBeNull();
    expect(historyDirection(key("ArrowUp", { altKey: true, ctrlKey: true }))).toBeNull();
    expect(historyDirection(key("a", { altKey: true }))).toBeNull();
  });
});
