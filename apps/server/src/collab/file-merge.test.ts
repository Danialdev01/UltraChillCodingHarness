import { describe, expect, it } from "vitest";
import { rebase } from "./file-merge.js";

const apply = (text: string, change: ReturnType<typeof rebase>) =>
  change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;

describe("bringing an open file up to date with the disk", () => {
  it("takes the disk's change when nothing was typed since the last write", () => {
    expect(apply("one\ntwo\n", rebase("one\ntwo\n", "one\ntwo\n", "one\n2\n"))).toBe("one\n2\n");
  });

  it("is nothing when the disk did not change", () => {
    expect(rebase("a\n", "ab\n", "a\n")).toBeNull();
  });

  it("keeps unwritten typing above the disk's change", () => {
    const base = "alpha\nbeta\ngamma\n";
    const local = "ALPHA!\nbeta\ngamma\n";
    const remote = "alpha\nbeta\nGAMMA\n";
    expect(apply(local, rebase(base, local, remote))).toBe("ALPHA!\nbeta\nGAMMA\n");
  });

  it("keeps unwritten typing below the disk's change", () => {
    const base = "alpha\nbeta\ngamma\n";
    const local = "alpha\nbeta\ngamma and more\n";
    const remote = "a\nbeta\ngamma\n";
    expect(apply(local, rebase(base, local, remote))).toBe("a\nbeta\ngamma and more\n");
  });

  it("lets the disk win where the two overlap", () => {
    const base = "alpha\nbeta\n";
    const local = "alpha\nbeta typed\n";
    const remote = "alpha\nbeta rewritten\n";
    expect(apply(local, rebase(base, local, remote))).toBe(remote);
  });

  it("does not guess an order for two inserts at one place", () => {
    expect(apply("ab", rebase("a", "ab", "ac"))).toBe("ac");
  });
});
