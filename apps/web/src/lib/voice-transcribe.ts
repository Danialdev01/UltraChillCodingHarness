/**
 * Dictation for the composer, without React.
 *
 * Two engines. The browser's own speech recognition (Chrome, Edge, Safari)
 * is live and free, so it goes first. Where there is none (Firefox) the
 * clip is recorded, converted to WAV, and sent to the server, which passes
 * it to an audio-capable OpenRouter model on the user's own key
 * (`GET /api/transcribe/status` says whether they have one).
 */

/** The part of the Web Speech API that is used here. lib.dom does not type it everywhere. */
export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export interface SpeechResultEventLike {
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** The browser's speech recognition, or null where it has none. */
export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether this browser can record a clip for the server fallback. */
export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

/** The first recording format this browser supports that the server knows, or "" for the browser's default. */
export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

/** Everything heard so far in one recognition session, finals and the guess in progress. */
export function transcriptOf(event: SpeechResultEventLike): string {
  const parts: string[] = [];
  for (let i = 0; i < event.results.length; i++) {
    const text = event.results[i]![0].transcript.trim();
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

/**
 * The draft with `spoken` put in at `caret`. It adds a space against a
 * neighbouring word but never doubles whitespace that is already there.
 */
export function insertTranscript(base: string, caret: number, spoken: string): string {
  const text = spoken.trim();
  if (!text) return base;
  const at = Math.max(0, Math.min(caret, base.length));
  const before = base.slice(0, at);
  const after = base.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return before + lead + text + trail + after;
}

/** The rate the clip is resampled to: plenty for speech, and a quarter the size of 44.1 kHz. */
export const WAV_SAMPLE_RATE = 16_000;

/** Mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/**
 * A recording as 16 kHz mono WAV. Every audio model on OpenRouter takes
 * WAV, and none of them take the WebM or Ogg Opus that MediaRecorder
 * produces everywhere.
 */
export async function toWav(blob: Blob): Promise<Blob> {
  const decoder = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void decoder.close();
  }
  const length = Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, length, WAV_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return new Blob([encodeWav(rendered.getChannelData(0), WAV_SAMPLE_RATE)], { type: "audio/wav" });
}

/** Whether the server can transcribe a clip. False on any failure: no mic beats a broken one. */
export async function serverTranscribeAvailable(): Promise<boolean> {
  try {
    const response = await fetch("/api/transcribe/status", { credentials: "include" });
    if (!response.ok) return false;
    return Boolean(((await response.json()) as { available?: boolean }).available);
  } catch {
    return false;
  }
}

/** Sends a recorded clip to the server and returns what was said. */
export async function transcribeBlob(hash: string, recording: Blob): Promise<string> {
  const blob = await toWav(recording);
  const query = new URLSearchParams({ type: blob.type });
  const response = await fetch(`/api/projects/${hash}/transcribe?${query}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/octet-stream" },
    body: blob,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? "Could not transcribe the recording.");
  }
  return ((await response.json()) as { text: string }).text;
}

/** A recognition error code as a sentence for the composer. */
export function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was blocked.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Speech recognition needs a network connection.";
    default:
      return `Dictation stopped (${code}).`;
  }
}
