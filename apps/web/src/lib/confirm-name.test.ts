import { describe, expect, it } from "vitest";
import { confirmsName } from "./confirm-name.js";

describe("confirmsName", () => {
  it("accepts the name exactly", () => {
    expect(confirmsName("express", "express")).toBe(true);
  });

  it("forgives whitespace either side, because a copied name carries it", () => {
    expect(confirmsName("  express\n", "express")).toBe(true);
    expect(confirmsName("express", " express ")).toBe(true);
  });

  it("refuses a near miss", () => {
    // The three "laravel" rows in the sidebar are why this is exact.
    expect(confirmsName("Express", "express")).toBe(false);
    expect(confirmsName("expres", "express")).toBe(false);
    expect(confirmsName("express-api", "express")).toBe(false);
    expect(confirmsName("ex press", "express")).toBe(false);
  });

  it("refuses an empty box, whatever the name is", () => {
    expect(confirmsName("", "express")).toBe(false);
    expect(confirmsName("   ", "express")).toBe(false);
    expect(confirmsName("", "")).toBe(false);
  });
});
