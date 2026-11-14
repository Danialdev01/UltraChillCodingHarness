import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeWav, insertTranscript, pickRecorderMime, transcriptOf } from "./voice-transcribe";

describe("insertTranscript", () => {
  it("fills an empty draft", () => {
    expect(insertTranscript("", 0, " hello world ")).toBe("hello world");
  });

  it("adds a space against a neighbouring word", () => {
    expect(insertTranscript("fix the", 7, "login bug")).toBe("fix the login bug");
    expect(insertTranscript("please now", 6, "check")).toBe("please check now");
  });

  it("does not double whitespace that is already there", () => {
    expect(insertTranscript("fix the ", 8, "bug")).toBe("fix the bug");
    expect(insertTranscript("a\n", 2, "b")).toBe("a\nb");
  });

  it("clamps a stale caret and ignores silence", () => {
    expect(insertTranscript("abc", 99, "d")).toBe("abc d");
    expect(insertTranscript("abc", 1, "   ")).toBe("abc");
  });
});

describe("transcriptOf", () => {
  it("joins finals and the guess in progress", () => {
    const results = [
      { isFinal: true, 0: { transcript: "hello " } },
      { isFinal: false, 0: { transcript: " wor" } },
    ];
    expect(transcriptOf({ results })).toBe("hello wor");
  });
});

describe("pickRecorderMime", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers opus webm, then falls back", () => {
    vi.stubGlobal("MediaRecorder", { isTypeSupported: (t: string) => t === "audio/mp4" });
    expect(pickRecorderMime()).toBe("audio/mp4");
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
    expect(pickRecorderMime()).toBe("audio/webm;codecs=opus");
    vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
    expect(pickRecorderMime()).toBe("");
  });
});

describe("encodeWav", () => {
  it("writes a 16-bit mono PCM header and clamps samples", () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1, 2]), 16_000));
    const text = (at: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => wav.getUint8(at + i)));
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(wav.getUint16(22, true)).toBe(1);
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getUint32(40, true)).toBe(8);
    expect(wav.byteLength).toBe(44 + 8);
    expect([0, 1, 2, 3].map((i) => wav.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });
});
