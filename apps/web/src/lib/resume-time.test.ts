import { describe, expect, it } from "vitest";
import { fromLocalInput, suggestedResume, toLocalInput } from "./resume-time";

describe("when a limited session carries on", () => {
  const now = Date.parse("2026-11-24T10:00:30Z");
  it("is offered just past the reset, else a session window away", () => {
    expect(suggestedResume("2026-11-24T12:00:00Z", now)).toBe(Date.parse("2026-11-24T12:01:00Z"));
    expect(suggestedResume("2026-11-24T09:00:00Z", now)).toBe(Date.parse("2026-11-24T15:01:00Z"));
    expect(suggestedResume(undefined, now)).toBe(Date.parse("2026-11-24T15:01:00Z"));
  });
  it("goes through the input and back", () => {
    const at = Date.parse("2026-11-24T12:01:00Z");
    expect(fromLocalInput(toLocalInput(at))).toBe("2026-11-24T12:01:00.000Z");
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("soon")).toBeNull();
  });
});
