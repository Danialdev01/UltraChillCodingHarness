import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readLastModel,
  readLastProvider,
  rememberLastModel,
  rememberLastProvider,
} from "./model-preference.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const OTHER = "44444444-4444-4444-4444-444444444444";

function store(impl?: Partial<Storage>) {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    ...impl,
  });
  return data;
}

afterEach(() => vi.unstubAllGlobals());

describe("the last model used per project", () => {
  it("comes back for the project it was saved under, and no other", () => {
    store();
    rememberLastModel(PROJECT, "anthropic/claude-sonnet-4.5");

    expect(readLastModel(PROJECT)).toBe("anthropic/claude-sonnet-4.5");
    expect(readLastModel(OTHER)).toBeNull();
  });

  it("keeps the newest choice", () => {
    store();
    rememberLastModel(PROJECT, "openai/gpt-5");
    rememberLastModel(PROJECT, "anthropic/claude-opus-4.1");
    expect(readLastModel(PROJECT)).toBe("anthropic/claude-opus-4.1");
  });

  it("does not save the empty id the picker holds before the catalogue loads", () => {
    store();
    rememberLastModel(PROJECT, "");
    expect(readLastModel(PROJECT)).toBeNull();
  });

  it("survives storage that throws, which is a private window with site data blocked", () => {
    store({
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });

    expect(() => rememberLastModel(PROJECT, "openai/gpt-5")).not.toThrow();
    expect(readLastModel(PROJECT)).toBeNull();
  });

  it("survives storage that is not there at all", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(readLastModel(PROJECT)).toBeNull();
    expect(() => rememberLastModel(PROJECT, "openai/gpt-5")).not.toThrow();
  });
});

describe("the last provider used per project", () => {
  it("is kept apart from the model, per project", () => {
    const data = store();
    rememberLastModel(PROJECT, "openai/gpt-5");
    rememberLastProvider(PROJECT, "claude");

    expect(readLastProvider(PROJECT)).toBe("claude");
    expect(readLastModel(PROJECT)).toBe("openai/gpt-5");
    expect(readLastProvider(OTHER)).toBeNull();
    expect([...data.keys()]).toHaveLength(2);
  });

  it("does not store an empty choice", () => {
    const data = store();
    rememberLastProvider(PROJECT, "");
    expect(data.size).toBe(0);
  });

  it("survives storage that throws", () => {
    store({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberLastProvider(PROJECT, "codex")).not.toThrow();
    expect(readLastProvider(PROJECT)).toBeNull();
  });
});
