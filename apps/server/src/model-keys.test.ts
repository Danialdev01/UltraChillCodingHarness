import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { users } from "@ucch/db";
import {
  checkModelKeyFormat,
  checkModelKeyLive,
  keyedModel,
  accountOpenRouterKey,
  mapAnonCatalog,
  modelKeyPrefix,
  parseKeyedModel,
} from "./model-keys.js";

const ID = "0b9c5d1e-2f3a-4b5c-8d6e-7f8091a2b3c4";

describe("keyed model ids", () => {
  it("round-trips a model id with slashes and a suffix", () => {
    const id = keyedModel(ID, "anthropic/claude-sonnet-4:beta");
    expect(id).toBe(`@${ID}/anthropic/claude-sonnet-4:beta`);
    expect(parseKeyedModel(id)).toEqual({ keyId: ID, model: "anthropic/claude-sonnet-4:beta" });
  });

  it("leaves a plain model id alone", () => {
    expect(parseKeyedModel("anthropic/claude-sonnet-4")).toBeNull();
    expect(parseKeyedModel("@not-a-uuid/x")).toBeNull();
  });
});

describe("key formats", () => {
  it("accepts AnonRouter inference keys and refuses management keys", () => {
    expect(checkModelKeyFormat("anonrouter", "ar_abcdefgh12345678")).toBeNull();
    expect(checkModelKeyFormat("anonrouter", "arm_abcdefgh12345678")).toMatch(/management key/);
    expect(checkModelKeyFormat("anonrouter", "sk-or-v1-abcdefghijklmnopqrstuvwxyz")).toMatch(/ar_/);
    expect(modelKeyPrefix("anonrouter", "ar_abcdefgh")).toBe("ar_");
  });

  it("accepts OpenRouter keys", () => {
    expect(checkModelKeyFormat("openrouter", "sk-or-v1-abcdefghijklmnopqrstuvwxyz")).toBeNull();
    expect(checkModelKeyFormat("openrouter", "ar_abcdefgh12345678")).toMatch(/OpenRouter/);
  });
});

describe("live check", () => {
  it("asks AnonRouter's model list with the key, and reads only the status", async () => {
    const calls: { url: string; auth: string | undefined }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: (init?.headers as Record<string, string>).authorization });
      return new Response("{\"error\":{\"message\":\"echo ar_secret\"}}", { status: 401 });
    };
    const result = await checkModelKeyLive("anonrouter", "ar_secret", fetchImpl);
    expect(calls).toEqual([{ url: "https://api.anonrouter.ai/v1/models", auth: "Bearer ar_secret" }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toContain("ar_secret");
  });
});

describe("AnonRouter catalogue", () => {
  it("keeps callable text models, drops e2ee and deprecated routes, maps features", () => {
    const models = mapAnonCatalog({
      models: [
        { id: "z-ai/glm-5.2", displayName: "GLM 5.2", callable: true, primaryModality: "text", privacyLevel: "private", contextTokens: 200000, features: ["reasoning", "tool-calling"] },
        { id: "google/gemma-e2ee", callable: true, primaryModality: "text", privacyLevel: "e2ee" },
        { id: "openai/embed", callable: true, primaryModality: "embedding", privacyLevel: "private" },
        { id: "meta/llama-old", callable: true, primaryModality: "text", privacyLevel: "anonymous", availability: "deprecated" },
        { id: "qwen/qwen-vl", callable: true, primaryModality: "text", privacyLevel: "anonymous", features: ["vision"] },
        { id: "x/not-callable", callable: false, primaryModality: "text" },
      ],
    });
    expect(models).toEqual([
      { id: "qwen/qwen-vl", name: "qwen/qwen-vl", provider: "qwen", contextLength: null, reasoning: false, images: true },
      { id: "z-ai/glm-5.2", name: "GLM 5.2", provider: "z-ai", contextLength: 200000, reasoning: true, images: false },
    ]);
  });

  it("flags the models AnonRouter calls uncensored, and only those", () => {
    const models = mapAnonCatalog({
      models: [
        { id: "mistralai/mistral-uncensored-1.2", callable: true, primaryModality: "text", privacyLevel: "private", moderation: "uncensored" },
        { id: "z-ai/glm-5.2", callable: true, primaryModality: "text", privacyLevel: "private", moderation: "unknown" },
      ],
    });
    expect(models.map((m) => [m.id, m.uncensored])).toEqual([
      ["mistralai/mistral-uncensored-1.2", true],
      ["z-ai/glm-5.2", undefined],
    ]);
  });
});

describe("the account's OpenRouter key", () => {
  // Drizzle leaves columns unqualified in a one-table select; the subquery's
  // match on the user must name both tables, or "id" is the key's own.
  it("matches the named key to the user by table-qualified columns", () => {
    const db = drizzle({ connection: "postgres://x@localhost:1/x" });
    const { sql } = db.select({ key: accountOpenRouterKey }).from(users).where(eq(users.id, "u")).toSQL();
    expect(sql).toContain('mk."user_id" = "users"."id"');
    expect(sql).toContain('"users"."openrouter_key_encrypted"');
  });
});
