import { createReadStream, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { DomainEvent } from "@ucch/protocol";
import type { AgentRun, ProviderRunInput } from "./types.js";

export const CODEX_IMAGE_INSTRUCTIONS = `<image-output>
For image generation requests, use the built-in image_gen tool to actually generate the image; reading the imagegen skill or announcing generation does not finish the request. If generation is unavailable or fails, explain the failure rather than claiming success. Do not silently switch to a paid API or request an API key.
To display a generated image in this chat, copy the generated file into .ucch/generated-images/ in the current working directory, then include Markdown ![description](.ucch/generated-images/filename.png) in your answer. Use a unique filename for every generation and regeneration. The chat renders workspace-relative image paths. If the user requests saving to a particular workspace path, save there and use that relative path in the Markdown instead. Preserve earlier images when regenerating.
</image-output>`;

/** Exec versions can omit image items from JSONL; the exact thread's rollout retains them. */
export function codexRollout(home: string | undefined, session: string | undefined): string | null {
  if (!home || !session || !/^[a-zA-Z0-9-]+$/.test(session)) return null;
  function find(dir: string, depth: number): string | null {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(`-${session}.jsonl`)) return join(dir, entry.name);
      }
      if (depth) for (const entry of entries.reverse()) {
        if (entry.isDirectory()) {
          const found = find(join(dir, entry.name), depth - 1);
          if (found) return found;
        }
      }
    } catch {}
    return null;
  }
  return find(join(home, "sessions"), 3);
}

export function rolloutImagePaths(record: unknown): string[] {
  if (!record || typeof record !== "object") return [];
  const value = record as Record<string, unknown>;
  if (value.type === "event_msg" || value.type === "response_item") return rolloutImagePaths(value.payload);
  if (value.type === "item_completed") return rolloutImagePaths(value.item);
  if (!["image_generation_end", "image_generation", "imageGeneration"].includes(String(value.type))) return [];
  if (value.status === "failed" || value.error) return [];
  const path = value.saved_path ?? value.savedPath;
  return typeof path === "string" ? [path] : [];
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

/** Only generated images or files already inside this workspace can become chat artifacts. */
export async function importCodexImage(input: ProviderRunInput, path: string): Promise<string> {
  const root = await realpath(input.ctx.cwd);
  const source = await realpath(resolve(root, path));
  const home = input.ctx.env.CODEX_HOME;
  const generatedRoot = home ? await realpath(join(home, "generated_images")).catch(() => null) : null;
  if (!within(root, source) && !(generatedRoot && within(generatedRoot, source))) throw new Error("Image is outside the session's image directories");
  if (!/\.(png|jpe?g|webp|gif)$/i.test(source)) throw new Error("Unsupported generated image format");
  const info = await stat(source);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Generated image is too large");
  if (within(root, source)) return relative(root, source).split("\\").join("/");
  // Check each parent before writing: a workspace symlink must not redirect an artifact elsewhere.
  let directory = root;
  for (const segment of [".ucch", "generated-images", input.turnId]) {
    if (!/^[\w.-]+$/.test(segment) || segment === "..") throw new Error("Invalid artifact directory");
    directory = join(directory, segment);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if (!within(root, await realpath(directory))) throw new Error("Image directory escapes the workspace");
  }
  const bytes = await readFile(source);
  const name = `${createHash("sha256").update(bytes).digest("hex")}${extname(basename(source)).toLowerCase()}`;
  const destination = join(directory, name);
  await writeFile(destination, bytes, { flag: "wx", mode: 0o600 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return relative(root, destination).split("\\").join("/");
}

/** Publish artifacts before completing the turn, so replay and the live chat agree. */
export function withCodexImages(input: ProviderRunInput, start: () => AgentRun, sessionId: () => string | null, imagePaths: () => readonly string[]): AgentRun {
  const previous = codexRollout(input.ctx.env.CODEX_HOME, input.resumeToken);
  let offset = 0;
  try { if (previous) offset = statSync(previous).size; } catch {}
  const run = start();
  return {
    ...run,
    events: {
      async *[Symbol.asyncIterator]() {
        const terminal: DomainEvent[] = [];
        const rendered: string[] = [];
        for await (const event of run.events) {
          if (event.type === "agent.turn_completed" || event.type === "agent.turn_failed") terminal.push(event);
          else {
            if (event.type === "agent.message") {
              for (const block of event.content) {
                if (!block || typeof block !== "object" || !("text" in block) || typeof block.text !== "string") continue;
                for (const match of block.text.matchAll(/!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))/g)) {
                  const path = match[1] ?? match[2]!;
                  if (!/^(?:[a-z]+:|\/)/i.test(path)) {
                    try { rendered.push(decodeURIComponent(path)); } catch {}
                  }
                }
              }
            }
            yield event;
          }
        }
        const paths = new Set(imagePaths());
        const rollout = codexRollout(input.ctx.env.CODEX_HOME, sessionId() ?? input.resumeToken);
        if (rollout) {
          const lines = createInterface({ input: createReadStream(rollout, { start: rollout === previous ? offset : 0 }), crlfDelay: Infinity });
          try {
            for await (const line of lines) {
              try { for (const path of rolloutImagePaths(JSON.parse(line))) paths.add(path); } catch {}
            }
          } catch {
            // Artifact recovery is optional; an unreadable rollout must not lose the turn result.
          } finally { lines.close(); }
        }
        const shown = new Set<string>();
        const digests = new Set<string>();
        for (const path of rendered) {
          try {
            const local = await importCodexImage(input, path);
            digests.add(createHash("sha256").update(await readFile(join(input.ctx.cwd, local))).digest("hex"));
          } catch {}
        }
        for (const path of paths) {
          let text: string;
          try {
            const relativePath = await importCodexImage(input, path);
            if (shown.has(relativePath)) continue;
            shown.add(relativePath);
            const digest = createHash("sha256").update(await readFile(join(input.ctx.cwd, relativePath))).digest("hex");
            if (digests.has(digest)) continue;
            digests.add(digest);
            text = `\n\n![Generated image](<${relativePath.split("/").map(encodeURIComponent).join("/")}>)`;
          } catch {
            text = "\n\nAn image was generated, but it could not be loaded into this chat. Ask the agent to save it inside this session's working directory and try again.";
          }
          const ids = { threadId: input.threadId, turnId: input.turnId };
          yield { type: "agent.text_delta", ...ids, text };
          yield { type: "agent.message", ...ids, content: [{ type: "text", text }] };
        }
        for (const event of terminal) yield event;
      },
    },
  };
}
