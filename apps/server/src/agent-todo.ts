import { readdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";

import { TASK_STAGES, verificationText, type ProjectTask, type TaskStage } from "@ucch/protocol";

import { agentPath, Debouncer, hasCheckout, safeSegment, writeIfChanged } from "./agent-sync.js";
import { refreshIndexFiles } from "./dev-database.js";

/**
 * `.agent/todo.md`: the project's Tasks board as a file, for agents to read.
 *
 * One way, board to file. The board (Postgres) stays the source of truth;
 * this is rewritten after every change to a card, and images or files
 * attached to a card are copied next to it under `.agent/references/todo/`.
 */

export const TODO_FILE = "todo.md";
export const TODO_REFERENCES = "references/todo";

const STAGE_TITLES: Record<TaskStage, string> = {
  idea: "Idea",
  research: "Research",
  ongoing: "Ongoing",
  verification: "Verification",
  done: "Done",
};

/** The most of a card's research notes the file carries; the board has the rest. */
const RESEARCH_MAX = 4000;

/** Where each upload of each card lands, relative to `.agent/`: unique within the card. */
export function attachmentPaths(task: ProjectTask): Map<string, string> {
  const paths = new Map<string, string>();
  const used = new Set<string>();
  for (const ref of task.references) {
    if (ref.kind !== "upload" || paths.has(ref.uploadId)) continue;
    const name = safeSegment(ref.name, "attachment");
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      const ext = extname(name);
      candidate = `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
    }
    used.add(candidate.toLowerCase());
    paths.set(ref.uploadId, `${TODO_REFERENCES}/${task.id}/${candidate}`);
  }
  return paths;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

/** Markdown-safe one-line text: a title must not start a heading or break the list. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A link target with spaces and parentheses escaped, so it stays one link. */
function href(path: string): string {
  return encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export function renderTodoMarkdown(tasks: readonly ProjectTask[]): string {
  const out: string[] = [
    "# Todo",
    "",
    "<!-- Generated from the app's Tasks board. Edit tasks in the app; changes made here are overwritten. -->",
    "",
    "Every planned task, by stage. Attachments are in `.agent/references/todo/<task id>/`.",
  ];
  for (const stage of TASK_STAGES) {
    const cards = tasks.filter((t) => t.stage === stage).sort((a, b) => a.position - b.position);
    out.push("", `## ${STAGE_TITLES[stage]} (${cards.length})`);
    if (cards.length === 0) {
      out.push("", "_Nothing here._");
      continue;
    }
    for (const task of cards) {
      out.push("", `### ${inline(task.title)}`, "", `<!-- task:${task.id} -->`);
      const meta = [`stage: ${stage}`, `status: ${task.status}`, `updated: ${task.updatedAt}`];
      if (task.attempts > 0) meta.push(`attempts: ${task.attempts}`);
      out.push(`- ${meta.join(" · ")}`);
      if (task.lastError) out.push(`- last error: ${inline(task.lastError)}`);

      if (task.description.trim()) out.push("", task.description.trim());

      const files = attachmentPaths(task);
      const refs = task.references.map((ref) => {
        if (ref.kind === "url") return `- <${ref.url}>`;
        if (ref.kind === "file") return `- file: \`${ref.path}\``;
        const path = files.get(ref.uploadId)!;
        const rel = href(path);
        return IMAGE.test(path) ? `- ![${inline(ref.name)}](${rel})` : `- [${inline(ref.name)}](${rel})`;
      });
      if (refs.length > 0) out.push("", "References:", "", ...refs);

      if (task.research?.trim()) {
        const research = task.research.trim();
        const cut = research.length > RESEARCH_MAX ? `${research.slice(0, RESEARCH_MAX)}\n\n…(truncated)` : research;
        out.push("", "<details><summary>Research</summary>", "", cut, "", "</details>");
      }
      if (task.verification) {
        const verdict = task.verification.passed ? "passed" : "failed";
        out.push("", `Verification (${verdict}): ${verificationText(task.verification)}`);
      }
      for (const fb of task.feedback) {
        out.push("", `Feedback: ${inline(fb.reason)}`, `Answer: ${inline(fb.answer)}`);
      }
    }
  }
  return `${out.join("\n")}\n`;
}

export interface TodoMirrorDeps {
  tasks: { list(projectId: string): Promise<ProjectTask[]> };
  uploads: { readBytes(projectId: string, uploadId: string): Promise<{ bytes: Buffer } | null> };
  /** The project's main checkout, where `.agent/` lives. */
  rootOf(projectId: string): string;
  onError(error: unknown, projectId: string): void;
  delayMs?: number;
}

/** Keeps `.agent/todo.md` and its attachments in step with a project's board. */
export class TodoMirror {
  readonly #debounce: Debouncer;

  constructor(private readonly deps: TodoMirrorDeps) {
    this.#debounce = new Debouncer(deps.delayMs ?? 500, (id) => this.#write(id), deps.onError);
  }

  /** After a card changed. */
  schedule(projectId: string): void {
    this.#debounce.schedule(projectId);
  }

  /** Now, for the boot backfill and tests. */
  flush(projectId: string): Promise<void> {
    return this.#debounce.flush(projectId);
  }

  async #write(projectId: string): Promise<void> {
    const root = this.deps.rootOf(projectId);
    if (!(await hasCheckout(root))) return;
    const tasks = await this.deps.tasks.list(projectId);

    let changed = false;
    const keep = new Set<string>();
    for (const task of tasks) {
      for (const [uploadId, path] of attachmentPaths(task)) {
        keep.add(task.id);
        const target = await agentPath(root, path);
        const upload = await this.deps.uploads.readBytes(projectId, uploadId);
        if (!upload) continue;
        if (await writeIfChanged(target, upload.bytes)) changed = true;
      }
    }

    // Cards deleted, or attachments removed: their copies go too.
    const refsDir = await agentPath(root, TODO_REFERENCES);
    for (const entry of await readdir(refsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !keep.has(entry.name)) {
        await rm(join(refsDir, entry.name), { recursive: true, force: true });
        changed = true;
        continue;
      }
      const task = tasks.find((t) => t.id === entry.name)!;
      const wanted = new Set([...attachmentPaths(task).values()].map((p) => p.split("/").pop()));
      for (const file of await readdir(join(refsDir, entry.name)).catch(() => [])) {
        if (!wanted.has(file)) {
          await rm(join(refsDir, entry.name, file), { force: true });
          changed = true;
        }
      }
    }

    if (await writeIfChanged(await agentPath(root, TODO_FILE), renderTodoMarkdown(tasks))) changed = true;
    if (changed) await refreshIndexFiles(root);
  }
}
