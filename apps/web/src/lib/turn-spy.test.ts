import { describe, expect, it } from "vitest";
import {
  activeTurnIndex,
  EDGE_SLACK,
  initialSpy,
  revealRow,
  spyReducer,
  turnPreview,
  type SpyEvent,
  type SpyState,
} from "./turn-spy.js";

// Five turns, 400px apart, in a 1000px box over 2400px of content.
const tops = [0, 400, 800, 1200, 1600];
const box = (scrollTop: number) => ({ scrollTop, clientHeight: 1000, scrollHeight: 2400 });

describe("activeTurnIndex", () => {
  it("picks the last turn whose top has passed the line 30% down", () => {
    // Line at 500 + 300 = 800: turn 2's top sits exactly on it.
    expect(activeTurnIndex(tops, box(500))).toBe(2);
    // One pixel short and it has not passed yet.
    expect(activeTurnIndex(tops, box(499))).toBe(1);
    // Line at 1000: turn 2 still, turn 3 starts at 1200.
    expect(activeTurnIndex(tops, box(700))).toBe(2);
  });

  it("gives the first turn at the very top, even when the line already passes a second", () => {
    const short = [0, 100, 900];
    expect(activeTurnIndex(short, box(0))).toBe(0);
    expect(activeTurnIndex(short, box(EDGE_SLACK))).toBe(0);
    // Just off the top, the line rule takes over.
    expect(activeTurnIndex(short, box(EDGE_SLACK + 1))).toBe(1);
  });

  it("gives the last turn on the floor, though its top never reaches the line", () => {
    // Max scrollTop is 1400; the line is at 1700 there, past the last top anyway,
    // so use a last turn that starts low.
    const late = [0, 400, 800, 1200, 2300];
    expect(activeTurnIndex(late, box(1400))).toBe(4);
    expect(activeTurnIndex(late, box(1400 - EDGE_SLACK))).toBe(4);
    expect(activeTurnIndex(late, box(1400 - EDGE_SLACK - 1))).toBe(3);
  });

  it("gives the newest turn when nothing scrolls", () => {
    expect(activeTurnIndex([0, 50, 100], { scrollTop: 0, clientHeight: 1000, scrollHeight: 600 })).toBe(2);
  });

  it("gives the first turn when the line is above every turn", () => {
    // Content before the first prompt (a handoff row) pushes it down.
    expect(activeTurnIndex([600, 900], box(100))).toBe(0);
  });

  it("is -1 without turns", () => {
    expect(activeTurnIndex([], box(0))).toBe(-1);
  });
});

function run(events: SpyEvent[], from: SpyState = initialSpy): SpyState {
  return events.reduce(spyReducer, from);
}

describe("spyReducer: the jump lock", () => {
  it("follows the scroll position when nothing is locked", () => {
    expect(run([{ type: "spy", id: "a" }, { type: "spy", id: "b" }]).activeId).toBe("b");
  });

  it("highlights a clicked turn at once and ignores the turns scrolled past on the way", () => {
    const state = run([
      { type: "spy", id: "a" },
      { type: "jump", id: "e" },
      { type: "spy", id: "b" },
      { type: "spy", id: "c" },
      { type: "spy", id: "d" },
    ]);
    expect(state).toEqual({ activeId: "e", locked: true });
  });

  it("keeps the clicked turn once the scroll settles, then follows the next scroll", () => {
    const settled = run([{ type: "jump", id: "d" }, { type: "settle" }]);
    expect(settled).toEqual({ activeId: "d", locked: false });
    expect(spyReducer(settled, { type: "spy", id: "e" }).activeId).toBe("e");
  });

  it("lets go when the reader scrolls by hand mid-jump, and takes their position", () => {
    const state = run([
      { type: "jump", id: "e" },
      { type: "spy", id: "b" },
      { type: "manual", id: "c" },
    ]);
    expect(state).toEqual({ activeId: "c", locked: false });
    // And spying works again straight after.
    expect(spyReducer(state, { type: "spy", id: "a" }).activeId).toBe("a");
  });

  it("returns the same state when nothing changes, so React skips the render", () => {
    const state = run([{ type: "spy", id: "a" }]);
    expect(spyReducer(state, { type: "spy", id: "a" })).toBe(state);
    expect(spyReducer(state, { type: "settle" })).toBe(state);
    expect(spyReducer(state, { type: "manual", id: "a" })).toBe(state);
  });

  it("forgets everything on reset", () => {
    expect(run([{ type: "jump", id: "x" }, { type: "reset" }])).toBe(initialSpy);
  });
});

describe("turnPreview", () => {
  it("takes the first non-empty line", () => {
    expect(turnPreview("\n  \n  Fix the build  \nand the tests")).toBe("Fix the build");
  });

  it("cuts long lines to 60 characters with an ellipsis", () => {
    const out = turnPreview("x".repeat(80));
    expect(Array.from(out)).toHaveLength(60);
    expect(out.endsWith("…")).toBe(true);
    expect(turnPreview("y".repeat(60))).toBe("y".repeat(60));
  });

  it("names the files of a prompt that is only files", () => {
    expect(turnPreview("", [{ name: "a.png" }, { name: "b.txt" }])).toBe("a.png, b.txt");
    expect(turnPreview("")).toBe("(empty message)");
  });
});

describe("revealRow", () => {
  const view = { scrollTop: 120, clientHeight: 300 };
  it("leaves a visible row alone", () => {
    expect(revealRow({ top: 200, height: 12 }, view)).toBeNull();
  });
  it("scrolls up just enough for a row above", () => {
    expect(revealRow({ top: 60, height: 12 }, view)).toBe(60);
  });
  it("scrolls down just enough for a row below", () => {
    expect(revealRow({ top: 480, height: 12 }, view)).toBe(192);
  });
});
