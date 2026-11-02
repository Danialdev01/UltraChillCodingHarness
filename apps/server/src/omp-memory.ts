import { createRequire } from "node:module";

/**
 * `node:sqlite`, required rather than imported: Vite's list of Node
 * builtins predates it, so an import fails under vitest.
 */
export function sqlite(): typeof import("node:sqlite") {
  return createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
}

/**
 * End-of-turn retention for Claude Code and Codex turns (solution §7.3,
 * OM7.2). With the workspace's memory on and `retainCliTurns` set, a
 * completed turn's final answer -- the text of its last assistant message,
 * never a tool's output (§0.2) -- goes on stdin to a one-shot
 * `omp -p --no-session --tools retain` on the `smol` role, under an
 * overlay naming the project's bank. The model keeps what is durable and
 * drops the rest; OMP turns retain for themselves (`autoRetain`).
 */

/** How much of an answer is read: a long one is cut, not paid for whole. */
export const RETAIN_ANSWER_CHARS = 16_000;

export const RETAIN_PROMPT = [
  "The text on stdin is a coding agent's final answer at the end of one turn of work on this project.",
  "Keep in the project's memory only what a later session should know: conventions, decisions and their reasons, lessons from something that went wrong.",
  "Use the retain tool once, with project scope, one self-contained item per fact, at most five.",
  "Never retain secrets, credentials, personal data, or the state or progress of the current task.",
  "If nothing in it is durable, do not call the tool.",
  "Then reply with one line: how many facts you kept.",
].join(" ");

/**
 * The text of an `agent.message`'s content (Anthropic content blocks), or
 * null when it has none -- a message that was only tool calls.
 */
export function messageText(content: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** The answer as the retention run reads it on stdin. */
export function retainStdin(answer: string): string {
  const cut = answer.length > RETAIN_ANSWER_CHARS ? `${answer.slice(0, RETAIN_ANSWER_CHARS)}\n[… cut]` : answer;
  return `<answer>\n${cut}\n</answer>\n`;
}

/**
 * What the memory card shows for one project's bank (solution §7.3,
 * OM7.3). OMP's `/memory stats` is a slash command, which `-p` does not
 * run (OM0), so the card reads mnemopi's SQLite file: `working_memory`
 * holds each retained `fact` and each turn's `episode` (`memory_type`),
 * `episodic_memory` what consolidation made of them.
 */
export interface MemoryStats {
  /** No file yet: nothing has been retained. */
  exists: boolean;
  facts: number;
  episodes: number;
  /** Everything in the bank, consolidated entries included. */
  total: number;
  bytes: number;
  /** The newest entry's time, ISO. */
  lastAt: string | null;
}

const EMPTY: MemoryStats = { exists: false, facts: 0, episodes: 0, total: 0, bytes: 0, lastAt: null };

export async function memoryStats(path: string): Promise<MemoryStats> {
  const { stat } = await import("node:fs/promises");
  const info = await stat(path).catch(() => null);
  if (!info) return EMPTY;
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((row) => row.name),
    );
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number | bigint }).n);
    let facts = 0;
    let episodes = 0;
    let working = 0;
    let lastAt: string | null = null;
    if (tables.has("working_memory")) {
      facts = count("select count(*) as n from working_memory where memory_type = 'fact'");
      episodes = count("select count(*) as n from working_memory where memory_type = 'episode'");
      working = count("select count(*) as n from working_memory");
      lastAt = (db.prepare("select max(timestamp) as t from working_memory").get() as { t: string | null }).t;
    }
    const episodic = tables.has("episodic_memory") ? count("select count(*) as n from episodic_memory") : 0;
    return { exists: true, facts, episodes, total: working + episodic, bytes: info.size, lastAt };
  } finally {
    db.close();
  }
}

/**
 * Empties a project's bank: the file and SQLite's companions go. The next
 * turn with memory starts a new one. A turn already running keeps the
 * file it opened, and what it retains is lost with it.
 */
export async function clearMemory(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(`${path}${suffix}`, { force: true });
}
