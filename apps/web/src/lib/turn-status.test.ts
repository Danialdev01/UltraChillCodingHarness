import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  formatTokens,
  WORKING_WORDS,
  workingWord,
} from "./turn-status.js";

describe("the working word", () => {
  it("is the same word for the same turn and step", () => {
    // Picked inside a render, a random word would change on every keypress
    // elsewhere on the page, which reads as a glitch rather than progress.
    expect(workingWord("turn-a", 3)).toBe(workingWord("turn-a", 3));
  });

  it("moves on at the next step", () => {
    const turn = "turn-a";
    const seen = new Set([0, 1, 2, 3].map((step) => workingWord(turn, step)));
    expect(seen.size).toBe(4);
  });

  it("does not open two turns in a row on the same word", () => {
    expect(workingWord("11111111-1111-1111-1111-111111111111", 0)).not.toBe(
      workingWord("22222222-2222-2222-2222-222222222222", 0),
    );
  });

  it("always returns one of the words, however long it runs", () => {
    // The step is unbounded -- a turn can run for hours -- so the index has
    // to wrap rather than walk off the end of the list.
    for (const step of [0, 27, 28, 500, 100_000]) {
      expect(WORKING_WORDS).toContain(workingWord("turn-a", step));
    }
  });

  it("copes with an id it has never seen the shape of", () => {
    expect(WORKING_WORDS).toContain(workingWord("", 0));
    expect(WORKING_WORDS).toContain(workingWord("💥", 2));
  });
});

describe("elapsed time", () => {
  it("reads in the units a person would say", () => {
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(59_999)).toBe("59s");
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(223_000)).toBe("3m 43s");
  });

  it("drops the seconds once they are noise", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(7_530_000)).toBe("2h 5m");
  });

  it("never runs backwards", () => {
    // A clock behind the browser's by a moment is ordinary; "-1s" is not.
    expect(formatElapsed(-500)).toBe("0s");
  });
});

describe("the token estimate", () => {
  it("shows small counts exactly and large ones shortened", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(16_900)).toBe("16.9k");
    expect(formatTokens(250_000)).toBe("250k");
  });

  it("does not claim a precision an estimate does not have", () => {
    // One decimal past a thousand, and none past a hundred thousand.
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(123_456)).toBe("123k");
  });
});
