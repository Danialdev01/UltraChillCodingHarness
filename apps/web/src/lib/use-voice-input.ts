"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  canRecord,
  describeSpeechError,
  pickRecorderMime,
  serverTranscribeAvailable,
  speechRecognitionCtor,
  transcribeBlob,
  transcriptOf,
  type SpeechRecognitionLike,
} from "@/lib/voice-transcribe";

export type VoiceState = "idle" | "listening" | "transcribing";

/** A clip longer than this is stopped and sent, well under the server's limit. */
const MAX_RECORDING_MS = 2 * 60_000;

/**
 * Recognition errors that mean the browser's engine cannot work here at all,
 * as opposed to one session going wrong. Brave and distro Chromium builds
 * ship the API without Google's speech service behind it, so it fails with
 * "network" every time.
 */
const ENGINE_BROKEN = new Set(["network", "service-not-allowed", "language-not-supported"]);

const NO_KEY =
  "This browser cannot transcribe speech itself. Add an OpenRouter key in Settings → Providers " +
  "to dictate here, or use Chrome, Edge or Safari.";

/**
 * The composer's mic.
 *
 * `onTranscript` gets everything said in this session so far, not a delta.
 * With the browser's recognition that happens live, guesses included. With
 * the OpenRouter fallback it happens once, after stop. The composer puts the
 * text at the caret it remembered on `start`.
 */
export function useVoiceInput({
  hash,
  onTranscript,
  onError,
}: {
  hash: string;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [speechWorks, setSpeechWorks] = useState(false);
  // Whether the server can transcribe for this user: null until asked.
  const [server, setServer] = useState<boolean | null>(null);
  const [recordable, setRecordable] = useState(true);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Each session gets a number: callbacks from one that was abandoned
  // (by unmount or a thread switch) are ignored.
  const session = useRef(0);

  const callbacks = useRef({ onTranscript, onError });
  callbacks.current = { onTranscript, onError };

  // Decided after mount: neither engine exists during SSR. The server is
  // asked even when the browser has an engine, because that engine may turn
  // out not to work.
  useEffect(() => {
    setSpeechWorks(Boolean(speechRecognitionCtor()));
    const can = canRecord();
    setRecordable(can);
    if (!can) return;
    let live = true;
    void serverTranscribeAvailable().then((ok) => {
      if (live) setServer(ok);
    });
    return () => {
      live = false;
    };
  }, []);

  const engine: "speech" | "server" | null = speechWorks ? "speech" : recordable && server ? "server" : null;
  const unavailable =
    engine || (recordable && server === null)
      ? null
      : !recordable
        ? typeof window !== "undefined" && !window.isSecureContext
          ? "Dictation needs a secure connection (https or localhost)."
          : "This browser cannot record audio."
        : NO_KEY;

  const releaseMic = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);

  const abort = useCallback(() => {
    session.current++;
    recognition.current?.abort();
    recognition.current = null;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    recorder.current = null;
    releaseMic();
    setState("idle");
  }, [releaseMic]);

  // Abandon a session when the composer goes away or changes project.
  useEffect(() => abort, [abort, hash]);

  const stop = useCallback(() => {
    if (recognition.current) {
      recognition.current.stop();
      return;
    }
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
  }, []);

  /** Records a clip; on stop it goes to OpenRouter through the server. */
  const startRecording = useCallback(
    async (id: number) => {
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        if (session.current === id) {
          callbacks.current.onError("Microphone access was blocked.");
          setState("idle");
        }
        return;
      }
      if (session.current !== id) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = media;
      const mimeType = pickRecorderMime();
      const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      rec.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      rec.onstop = () => {
        releaseMic();
        recorder.current = null;
        if (session.current !== id) return;
        const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" });
        if (blob.size === 0) {
          setState("idle");
          return;
        }
        setState("transcribing");
        transcribeBlob(hash, blob).then(
          (text) => {
            if (session.current !== id) return;
            if (text) callbacks.current.onTranscript(text);
            setState("idle");
          },
          (error: unknown) => {
            if (session.current !== id) return;
            callbacks.current.onError(error instanceof Error ? error.message : String(error));
            setState("idle");
          },
        );
      };
      recorder.current = rec;
      rec.start();
      timer.current = setTimeout(() => {
        if (rec.state !== "inactive") rec.stop();
      }, MAX_RECORDING_MS);
      setState("listening");
    },
    [hash, releaseMic],
  );

  const start = useCallback(async () => {
    if (state !== "idle") return;
    if (!engine) {
      callbacks.current.onError(unavailable ?? "Dictation is still starting up. Try again in a moment.");
      return;
    }
    const id = ++session.current;

    if (engine === "server") {
      await startRecording(id);
      return;
    }

    const Ctor = speechRecognitionCtor()!;
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || "en-US";
    let switching = false;
    rec.onresult = (event) => {
      if (session.current === id) callbacks.current.onTranscript(transcriptOf(event));
    };
    rec.onerror = (event) => {
      // "aborted" is our own abort(), and "no-speech" just means silence.
      if (session.current !== id || event.error === "aborted" || event.error === "no-speech") return;
      if (ENGINE_BROKEN.has(event.error)) {
        // The browser's engine cannot work here: use OpenRouter from now on,
        // and carry on with this session by recording instead.
        setSpeechWorks(false);
        if (recordable && server) {
          switching = true;
          recognition.current = null;
          void startRecording(id);
          return;
        }
        callbacks.current.onError(recordable && server === false ? NO_KEY : describeSpeechError(event.error));
        return;
      }
      callbacks.current.onError(describeSpeechError(event.error));
    };
    rec.onend = () => {
      if (session.current !== id || switching) return;
      recognition.current = null;
      setState("idle");
    };
    recognition.current = rec;
    try {
      rec.start();
      setState("listening");
    } catch (error) {
      recognition.current = null;
      callbacks.current.onError(error instanceof Error ? error.message : String(error));
    }
  }, [engine, recordable, server, startRecording, state, unavailable]);

  return { state, supported: engine !== null, unavailable, engine, start, stop, abort };
}
