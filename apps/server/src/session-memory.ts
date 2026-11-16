import { mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { commitWorkingBank, prepareWorkingBank } from "./omp-memory.js";

/**
 * Which memories an OMP run recalls, and when they are forgotten.
 *
 * Every session (thread) keeps its own mnemopi bank under the subject that
 * pays, `memories/{project}/sessions/{thread}/mnemopi.db`; what a run is
 * handed is its own bank plus those of the sessions it may recall
 * (`prepareWorkingBank`), and only what it retains goes back into its own.
 * A project's older shared bank, `memories/{project}/mnemopi.db` -- what
 * runs wrote before sessions had banks, and what a hand-started CLI's
 * bridge in a terminal writes -- is recalled by every session of that
 * project.
 *
 * - In a project workspace a session recalls the project's active sessions
 *   and its settled ones.
 * - In a session workspace, where each session is its own project, a
 *   session recalls only the other active sessions that share a keyword
 *   with it.
 *
 * Deleting a session deletes its bank, so nothing it remembered reaches a
 * later run. Expired sessions are deleted by `SESSION_RETENTION`.
 */

/** How long a settled session is kept before it is deleted, data and memory. */
export const SESSION_RETENTION = {
  /** A project workspace's settled sessions. */
  projectSettledMs: 14 * 24 * 60 * 60_000,
  /** A session workspace's settled sessions. */
  sessionSettledMs: 7 * 24 * 60 * 60_000,
} as const;

/** One session's bank, or with `threadId` null its project's shared one. */
export interface MemoryBankRef {
  projectId: string;
  threadId: string | null;
}

export interface SessionMemoryDeps {
  /** The subject's `omp/memories` folder. */
  memoriesDir(subject: string): string;
  /** Every subject's `omp/memories` folder that exists, for forgetting. */
  allMemoriesDirs(): Promise<string[]>;
  /**
   * The banks a run of this session may recall besides its own, by the
   * rules above. `text` is what the run is about (its prompt), for a
   * session with no title yet.
   */
  recallable(session: MemoryBankRef, text: string): Promise<MemoryBankRef[]>;
  /** Whether the session still exists: a run of one deleted meanwhile keeps nothing. */
  exists(session: MemoryBankRef): Promise<boolean>;
}

/** What a run is handed: the bank file to name in its overlay, and what to do when it ends. */
export interface OpenedMemory {
  path: string;
  /** Puts what the run retained into the session's bank. Never throws. */
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkId(id: string): string {
  if (!UUID.test(id)) throw new Error(`not an id: ${id}`);
  return id;
}

export class SessionMemory {
  constructor(
    private readonly deps: SessionMemoryDeps,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** A bank's file under the subject. Its folder is made `0700`. */
  bankPath(subject: string, bank: MemoryBankRef): string {
    const project = join(this.deps.memoriesDir(subject), checkId(bank.projectId));
    const dir = bank.threadId ? join(project, "sessions", checkId(bank.threadId)) : project;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, "mnemopi.db");
  }

  /**
   * The working bank for one run, at `{runDir}/{key}.mnemopi.db`. Recall
   * that cannot be gathered must not cost the turn: the run then gets its
   * own bank alone.
   */
  async open(input: { subject: string; bank: MemoryBankRef; runDir: string; key: string; text: string }): Promise<OpenedMemory> {
    if (!/^[A-Za-z0-9_-]+$/.test(input.key)) throw new Error(`not a run key: ${input.key}`);
    const own = this.bankPath(input.subject, input.bank);
    const work = join(input.runDir, `${input.key}.mnemopi.db`);
    let sources: string[] = [];
    try {
      const recallable = await this.deps.recallable(input.bank, input.text);
      sources = recallable
        .filter((bank) => !(bank.projectId === input.bank.projectId && bank.threadId === input.bank.threadId))
        .map((bank) => this.bankPath(input.subject, bank));
    } catch (error) {
      this.onError(error);
    }
    try {
      await prepareWorkingBank(work, own, sources);
    } catch (error) {
      this.onError(error);
      await prepareWorkingBank(work, own, []);
    }
    return {
      path: work,
      close: async () => {
        try {
          const keep = await this.deps.exists(input.bank).catch(() => true);
          await commitWorkingBank(work, own, keep);
        } catch (error) {
          this.onError(error);
        }
      },
    };
  }

  /**
   * Deletes what a session remembered, under every subject; with no thread,
   * everything its project's sessions remembered. Not recoverable.
   */
  async forget(bank: { projectId: string; threadId?: string | null }): Promise<void> {
    const project = checkId(bank.projectId);
    const thread = bank.threadId ? checkId(bank.threadId) : null;
    for (const dir of await this.deps.allMemoriesDirs()) {
      const target = thread ? join(dir, project, "sessions", thread) : join(dir, project);
      await rm(target, { recursive: true, force: true });
    }
  }
}

/** Every subject's `omp/memories` under `CREDS_ROOT`. */
export async function memoriesDirsUnder(credsRoot: string): Promise<string[]> {
  const subjects = await readdir(credsRoot, { withFileTypes: true }).catch(() => []);
  return subjects.filter((entry) => entry.isDirectory()).map((entry) => join(credsRoot, entry.name, "omp", "memories"));
}

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before being below between both but by can " +
    "could did do does doing done down during each few for from further get got had has have having he her here hers him his how i " +
    "if in into is it its itself just let like make me more most my no nor not now of off on once only or other our ours out over own " +
    "please same she should so some such than that the their theirs them then there these they this those through to too under " +
    "until up use using very want was we were what when where which while who whom why will with would you your yours " +
    // Words every session's title could carry.
    "untitled session sessions chat new thing things stuff help work task tasks question questions"
  ).split(" "),
);

/** The words that say what a session is about: lowercased, three letters or more, no stopwords. */
export function sessionKeywords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
    // "tests" and "test" are one subject.
    words.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
    if (words.size >= 64) break;
  }
  return words;
}

/** Whether two sessions share a keyword. */
export function sharesKeyword(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const word of a) if (b.has(word)) return true;
  return false;
}

/** A title that says nothing yet: the session's prompt speaks for it. */
export function isPlaceholderTitle(title: string | null | undefined): boolean {
  return !title || sessionKeywords(title).size === 0;
}
