import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";

import { audioFormatFor, registerTranscribeRoutes, type TranscribeRouteDeps } from "./transcribe-routes.js";
import type { ProjectSummary } from "./workspaces.js";

let app: ReturnType<typeof Fastify> | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

function build(overrides: Partial<TranscribeRouteDeps> = {}) {
  const server = Fastify();
  app = server;
  server.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );
  registerTranscribeRoutes(server, {
    projectFor: async () => ({ id: "project" }) as ProjectSummary,
    openrouterKeyFor: async () => "sk-or-test",
    baseUrl: "https://openrouter.example/api/v1",
    model: "google/gemini-2.5-flash",
    ...overrides,
  });
  return server;
}

const clip = (url = "/api/projects/p/transcribe?type=audio%2Fwav", payload = Buffer.from("RIFFwave")) => ({
  method: "POST" as const,
  url,
  headers: { "content-type": "application/octet-stream" },
  payload,
});

it("maps clip types to OpenRouter audio formats", () => {
  expect(audioFormatFor("audio/wav")).toBe("wav");
  expect(audioFormatFor("audio/ogg;codecs=opus")).toBe("ogg");
  expect(audioFormatFor("audio/webm")).toBeNull();
});

it("reports whether this user has a key to transcribe with", async () => {
  expect((await build().inject("/api/transcribe/status")).json()).toEqual({ available: true });
  await app!.close();
  const none = build({ openrouterKeyFor: async () => null });
  expect((await none.inject("/api/transcribe/status")).json()).toEqual({ available: false });
});

it("answers 409 without a key and 404 outside a project", async () => {
  const response = await build({ openrouterKeyFor: async () => null }).inject(clip());
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toMatch(/OpenRouter key/);
  await app!.close();
  expect((await build({ projectFor: async () => null }).inject(clip())).statusCode).toBe(404);
});

it("refuses an empty clip or a type OpenRouter cannot take", async () => {
  const server = build();
  expect((await server.inject(clip(undefined, Buffer.alloc(0)))).statusCode).toBe(400);
  expect((await server.inject(clip("/api/projects/p/transcribe?type=text%2Fhtml"))).statusCode).toBe(400);
});

it("sends the clip to OpenRouter as input_audio and returns the transcript", async () => {
  const fetchStub = vi.fn(async () => Response.json({ choices: [{ message: { content: "  hello world \n" } }] }));
  const response = await build({ fetch: fetchStub as unknown as typeof fetch }).inject(clip());
  expect(response.json()).toEqual({ text: "hello world" });

  const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://openrouter.example/api/v1/chat/completions");
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-or-test");
  const body = JSON.parse(init.body as string);
  expect(body.model).toBe("google/gemini-2.5-flash");
  const audio = body.messages[0].content.find((part: { type: string }) => part.type === "input_audio");
  expect(audio.input_audio).toEqual({ data: Buffer.from("RIFFwave").toString("base64"), format: "wav" });
});

it("drops the model's no-speech marker instead of typing it", async () => {
  const fetchStub = vi.fn(async () => Response.json({ choices: [{ message: { content: "[no speech]" } }] }));
  expect((await build({ fetch: fetchStub as unknown as typeof fetch }).inject(clip())).json()).toEqual({ text: "" });
});

it("passes OpenRouter's reason on when it refuses", async () => {
  const fetchStub = vi.fn(async () => Response.json({ error: { message: "Insufficient credits" } }, { status: 402 }));
  const response = await build({ fetch: fetchStub as unknown as typeof fetch }).inject(clip());
  expect(response.statusCode).toBe(502);
  expect(response.json().error).toBe("Transcription failed (402): Insufficient credits");
});
