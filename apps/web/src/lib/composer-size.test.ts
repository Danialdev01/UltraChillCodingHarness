import { describe, expect, it } from "vitest";
import {
  composerMaxLines,
  MAX_COMPOSER_LINES,
  MIN_COMPOSER_LINES,
} from "./composer-size.js";

/** Roughly what `text-sm` computes to. */
const LINE = 20;

describe("how far the composer may grow", () => {
  it("stops at the desktop ceiling in a tall panel", () => {
    // 900px of chat could afford eighteen lines; ten is enough for anyone,
    // and the conversation is worth more than the eleventh.
    expect(composerMaxLines(900, LINE)).toBe(MAX_COMPOSER_LINES);
  });

  it("gives the conversation the majority of a short panel", () => {
    // A phone in landscape, or a desktop window dragged short. Two fifths of
    // 300px at 20px a line is six.
    expect(composerMaxLines(300, LINE)).toBe(6);
    expect(composerMaxLines(500, LINE)).toBe(10);
  });

  it("never collapses below the resting height, however little room there is", () => {
    // The floor matters more than the budget: a one-line composer in a
    // cramped panel is worse than one that scrolls.
    expect(composerMaxLines(60, LINE)).toBe(MIN_COMPOSER_LINES);
    expect(composerMaxLines(1, LINE)).toBe(MIN_COMPOSER_LINES);
  });

  it("follows the line height rather than assuming one", () => {
    // The same panel affords fewer lines of larger text; hardcoding 20px
    // would silently mis-size the box the moment the type scale changed.
    expect(composerMaxLines(400, 40)).toBe(4);
    expect(composerMaxLines(400, 16)).toBe(10);
  });

  it("behaves as it always did while the panel is still unmeasured", () => {
    // A ResizeObserver reports a frame or two after mount. Starting at the
    // ceiling means the composer never visibly shrinks into place.
    expect(composerMaxLines(0, LINE)).toBe(MAX_COMPOSER_LINES);
    expect(composerMaxLines(Number.NaN, LINE)).toBe(MAX_COMPOSER_LINES);
    expect(composerMaxLines(600, 0)).toBe(MAX_COMPOSER_LINES);
  });
});
