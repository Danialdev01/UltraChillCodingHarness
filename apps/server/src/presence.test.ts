import { describe, expect, it } from "vitest";
import { PresenceStore } from "./presence.js";

const P = "22222222-2222-2222-2222-222222222222";
const viewer = (clientId: string, location: string, editing = false) => ({
  userId: "11111111-1111-1111-1111-111111111111",
  clientId,
  location,
  editing,
});

describe("PresenceStore", () => {
  it("lists one viewer per socket, and reports only real changes", () => {
    const store = new PresenceStore();
    expect(store.set(P, "c1", viewer("a", "note:1"))).toHaveLength(1);
    expect(store.set(P, "c2", viewer("b", "note:1"))).toHaveLength(2);
    expect(store.set(P, "c1", viewer("a", "note:1"))).toBeNull();
    expect(store.set(P, "c1", viewer("a", "note:1", true))?.find((v) => v.clientId === "a")?.editing).toBe(true);
  });

  it("forgets a closed socket everywhere it was", () => {
    const store = new PresenceStore();
    store.set(P, "c1", viewer("a", "note:1"));
    store.set(P, "c2", viewer("b", "thread:1"));
    expect(store.drop("c1")).toEqual([{ projectId: P, viewers: [viewer("b", "thread:1")] }]);
    expect(store.drop("c1")).toEqual([]);
  });

  it("clears a place on null", () => {
    const store = new PresenceStore();
    store.set(P, "c1", viewer("a", "note:1"));
    expect(store.set(P, "c1", null)).toEqual([]);
    expect(store.set(P, "c1", null)).toBeNull();
  });
});
