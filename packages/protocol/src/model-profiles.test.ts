import { describe, expect, it } from "vitest";
import { modelProfile, pickModels, PICK_REASONS, type PickInput } from "./model-profiles.js";

const claude = { provider: "claude" as const, usable: true, knownModels: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2", "claude-haiku-5-5"].map((id) => ({ id })) };
const codex = { provider: "codex" as const, usable: true, models: ["gpt-5.1-codex-mini", "gpt-6-sol", "gpt-5"].map((id) => ({ id })) };
const omp = { provider: "omp" as const, usable: true };
const catalogue = ["google/gemini-2.5-pro", "google/gemini-3-pro", "google/gemini-3-pro:free", "x-ai/grok-4", "openai/gpt-7", "anthropic/claude-opus-9"].map((id) => ({ id }));

const base: PickInput = {
  role: "reviewer",
  author: { provider: "claude", model: "claude-opus-5-5" },
  count: 1,
  explicit: [],
  available: [claude, codex, omp],
  catalogue,
};
const models = (input: Partial<PickInput>) => pickModels({ ...base, ...input }).map((pick) => pick.model);

describe("modelProfile", () => {
  it.each([
    ["claude-opus-5-5", "anthropic", 1],
    ["opus", "anthropic", 1],
    ["gpt-6-sol", "openai", 1],
    ["openai/gpt-5-mini", "openai", 3],
    ["google/gemini-3-pro", "google", 1],
    ["x-ai/grok-4", "xai", 1],
    ["acme/wonder-9", "acme", 3],
    ["unheard-of", "other", 3],
  ])("%s", (id, vendor, tier) => {
    expect(modelProfile(id)).toMatchObject({ vendor, tier });
  });
});

describe("a reviewer", () => {
  it("is another vendor's strongest", () => {
    expect(pickModels(base)).toEqual([{ model: "gpt-6-sol", reason: PICK_REASONS.otherVendor }]);
    expect(models({ author: { provider: "codex", model: "gpt-6-sol" } })).toEqual(["claude-opus-5-5"]);
    expect(models({ author: { provider: "claude", model: null } })).toEqual(["gpt-6-sol"]);
  });
  it("comes from OpenRouter when no other vendor's CLI is usable", () => {
    expect(models({ available: [claude, { ...codex, usable: false }, omp] })).toEqual(["openai/gpt-7"]);
    expect(models({ available: [claude, { ...codex, usedPercent: 95 }, omp] })).toEqual(["openai/gpt-7"]);
  });
  it("falls back to another family, then to the author's own model", () => {
    expect(pickModels({ ...base, available: [claude] })).toEqual([{ model: "claude-sonnet-5-5", reason: PICK_REASONS.otherFamily }]);
    expect(pickModels({ ...base, available: [] })).toEqual([{ model: null, reason: PICK_REASONS.onlySame }]);
  });
  it("is whoever was named", () => {
    expect(pickModels({ ...base, explicit: ["kimi k2", "same"], count: 2 })).toEqual([
      { model: "kimi k2", reason: PICK_REASONS.asked },
      { model: null, reason: PICK_REASONS.same },
    ]);
  });
  it("follows the project's setting", () => {
    expect(models({ preference: "same" })).toEqual([null]);
    expect(models({ preference: "gpt-5" })).toEqual(["gpt-5"]);
    expect(models({ preference: "auto" })).toEqual(["gpt-6-sol"]);
    expect(models({ preference: "same", explicit: ["opus"] })).toEqual(["opus"]);
  });
});

describe("a council", () => {
  const council = { ...base, role: "council" as const, count: 4 };
  it("seats the session's model, then every vendor before any twice", () => {
    expect(models(council)).toEqual([null, "gpt-6-sol", "google/gemini-3-pro", "x-ai/grok-4"]);
  });
  it("reuses a vendor only once each is seated", () => {
    expect(models({ ...council, available: [claude, codex] })).toEqual([null, "gpt-6-sol", "gpt-5", "claude-sonnet-5-5"]);
  });
  it("fills the rest with the session's own", () => {
    expect(models({ ...council, available: [] })).toEqual([null, null, null, null]);
  });
  it("takes the named ones first", () => {
    expect(models({ ...council, count: 3, explicit: ["opus", "gpt-5"] })).toEqual(["opus", "gpt-5", "google/gemini-3-pro"]);
  });
  it("is the same every time", () => {
    const shuffled = { ...council, catalogue: [...catalogue].reverse(), available: [omp, codex, claude] };
    expect(models(shuffled)).toEqual(models(council));
  });
});
