import { describe, expect, it } from "vitest";
import { LOG_SCRUB, maskSecrets } from "./log-redact.js";

describe("maskSecrets", () => {
  it("masks vendor keys, session tokens and JWTs by their look", () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${"a".repeat(20)}.${"b".repeat(20)}`;
    const text = `oauth sk-ant-oat01-${"x".repeat(40)} key sk-or-v1-${"y".repeat(20)} sess-${"z".repeat(30)} jwt ${jwt}`;
    const masked = maskSecrets(text);
    for (const leaked of ["sk-ant-oat01-", "sk-or-v1-", "sess-zzz", "eyJhbGci"]) expect(masked).not.toContain(leaked);
    expect(masked).toContain("oauth <redacted>");
  });

  it("leaves ordinary text alone", () => {
    expect(maskSecrets("maxTokens: 24000, session ended")).toBe("maxTokens: 24000, session ended");
  });
});

describe("LOG_SCRUB", () => {
  it("masks a logged message and an error's message, stack and fields", () => {
    const calls: unknown[][] = [];
    LOG_SCRUB.hooks.logMethod.call(null, [{ a: 1 }, `failed with sk-ant-api03-${"q".repeat(30)}`], (...args) => calls.push(args));
    expect(calls[0]).toEqual([{ a: 1 }, "failed with <redacted>"]);
    const error = Object.assign(new Error(`Bearer ${"t".repeat(30)}`), { stderr: `ghp_${"g".repeat(30)}` });
    const out = LOG_SCRUB.serializers.err(error);
    expect(JSON.stringify(out)).not.toContain("ttttttttttttt");
    expect(JSON.stringify(out)).not.toContain("ghp_");
    expect(out).toMatchObject({ type: "Error", message: "Bearer <redacted>" });
  });
});
