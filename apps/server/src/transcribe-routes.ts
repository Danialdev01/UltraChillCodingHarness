import type { FastifyInstance } from "fastify";

import type { ProjectSummary } from "./workspaces.js";

type ProjectRequest = {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  params: { hash: string };
};

type SessionRequest = { cookies: Record<string, string | undefined> };

export interface TranscribeRouteDeps {
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  /**
   * The signed-in user's own OpenRouter key, decrypted. Null when there is no
   * session, no key, or no SECRET_KEY to decrypt it with.
   */
  openrouterKeyFor(request: SessionRequest): Promise<string | null>;
  /** OpenRouter's API root, without a trailing slash. */
  baseUrl: string;
  /** An OpenRouter model that takes audio input. */
  model: string;
  fetch?: typeof fetch;
}

/** Two minutes of 16 kHz mono WAV is about 4 MB; this leaves room. */
export const TRANSCRIBE_MAX_BYTES = 20 * 1024 * 1024;

/** The `input_audio.format` OpenRouter expects for a clip's MIME type. */
export function audioFormatFor(type: string): string | null {
  const base = type.split(";")[0]!.trim().toLowerCase();
  switch (base) {
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "audio/flac":
      return "flac";
    case "audio/aac":
      return "aac";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    default:
      return null;
  }
}

/** What the model says when there is nothing to transcribe, so noise never lands in the draft. */
const NO_SPEECH = "[no speech]";

const INSTRUCTIONS =
  "Transcribe the speech in this audio verbatim, in the language it is spoken. " +
  "Reply with the transcript only: no quotes, labels, timestamps or commentary. " +
  `If the audio holds no intelligible speech (silence, noise, a tone), reply with exactly ${NO_SPEECH}.`;

/**
 * The composer's dictation fallback, for browsers with no speech recognition
 * of their own (Firefox).
 *
 * OpenRouter has no transcription endpoint, so the clip goes to an
 * audio-capable chat model as an `input_audio` part, billed to the user's
 * own OpenRouter key like everything else they ask a model for.
 *
 * `GET /api/transcribe/status` says whether this user can use it, so the
 * mic can say why it cannot instead of failing on a click.
 * `POST /api/projects/:hash/transcribe` takes the clip as raw
 * `application/octet-stream` (the upload convention) with its type in the
 * query string, and answers `{ text }`.
 */
export function registerTranscribeRoutes(app: FastifyInstance, deps: TranscribeRouteDeps): void {
  const doFetch = deps.fetch ?? fetch;

  app.get("/api/transcribe/status", async (request) => ({
    available: Boolean(await deps.openrouterKeyFor(request)),
  }));

  app.post<{ Params: { hash: string }; Querystring: { type?: string } }>(
    "/api/projects/:hash/transcribe",
    {
      bodyLimit: TRANSCRIBE_MAX_BYTES,
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const project = await deps.projectFor(request);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const apiKey = await deps.openrouterKeyFor(request);
      if (!apiKey) {
        return reply
          .code(409)
          .send({ error: "Add an OpenRouter key in Settings → Providers to dictate in this browser." });
      }

      if (!Buffer.isBuffer(request.body)) {
        return reply.code(415).send({ error: "send the audio as application/octet-stream" });
      }
      if (request.body.length === 0) return reply.code(400).send({ error: "the recording is empty" });
      const format = audioFormatFor(request.query.type ?? "");
      if (!format) return reply.code(400).send({ error: "unsupported audio type" });

      let response: Response;
      try {
        response = await doFetch(`${deps.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: deps.model,
            temperature: 0,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: INSTRUCTIONS },
                  { type: "input_audio", input_audio: { data: request.body.toString("base64"), format } },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (error) {
        request.log.warn({ err: error }, "transcription request failed");
        return reply.code(502).send({ error: "Could not reach OpenRouter." });
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: unknown } };
        const detail = typeof body.error?.message === "string" ? `: ${body.error.message.slice(0, 200)}` : "";
        request.log.warn({ status: response.status }, "OpenRouter refused the clip");
        return reply.code(502).send({ error: `Transcription failed (${response.status})${detail}` });
      }
      const body = (await response.json().catch(() => ({}))) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      const text = typeof content === "string" ? content.trim() : "";
      return { text: text.toLowerCase().includes(NO_SPEECH) ? "" : text };
    },
  );
}
