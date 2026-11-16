import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitWorkingBank, prepareWorkingBank, sqlite } from "./omp-memory.js";
import { isPlaceholderTitle, SessionMemory, sessionKeywords, sharesKeyword, type MemoryBankRef } from "./session-memory.js";

/** The part of mnemopi's schema that matters here: a text key, an autoincrement one, FTS kept by triggers. */
const SCHEMA = `
  create table working_memory (id text primary key, content text not null, session_id text default 'default', channel_id text, memory_type text default 'fact');
  create table episodic_memory (rowid integer primary key autoincrement, id text unique not null, content text not null, session_id text default 'default');
  create virtual table fts_working using fts5(id unindexed, content);
  create trigger wm_ai after insert on working_memory begin insert into fts_working(id, content) values (new.id, new.content); end;
  create trigger wm_ad after delete on working_memory begin delete from fts_working where id = old.id; end;
`;

function bank(path: string, rows: { id: string; content: string }[]): void {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal");
  db.exec(SCHEMA);
  for (const row of rows) {
    db.prepare("insert into working_memory (id, content) values (?, ?)").run(row.id, row.content);
    db.prepare("insert into episodic_memory (id, content) values (?, ?)").run(`e-${row.id}`, row.content);
  }
  db.close();
}

function read(path: string): { working: string[]; episodes: string[]; fts: string[]; sessions: string[] } {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const col = (sql: string) => (db.prepare(sql).all() as { v: string }[]).map((row) => row.v).sort();
    return {
      working: col("select id as v from working_memory"),
      episodes: col("select id as v from episodic_memory"),
      fts: col("select id as v from fts_working where fts_working match 'memo'"),
      sessions: [...new Set(col("select session_id as v from working_memory"))],
    };
  } finally {
    db.close();
  }
}

/** What a run does: retain one more memory in the working bank. */
function retain(path: string, id: string): void {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path);
  db.exec(SCHEMA.replace(/create (table|virtual table|trigger) /g, "create $1 if not exists "));
  db.prepare("insert into working_memory (id, content) values (?, ?)").run(id, `memo ${id}`);
  db.prepare("insert into episodic_memory (id, content) values (?, ?)").run(`e-${id}`, `memo ${id}`);
  db.close();
}

describe("working banks", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "ucch-mem-"));

  it("hands a run its own memories and the ones it may recall, and keeps only what it added", async () => {
    const root = dir();
    const own = join(root, "own.db");
    const other = join(root, "other.db");
    const work = join(root, "work.db");
    bank(own, [{ id: "o1", content: "memo own" }]);
    bank(other, [{ id: "x1", content: "memo other" }]);
    // Another session's rows are under its own bank name.
    const { DatabaseSync } = sqlite();
    const db = new DatabaseSync(other);
    db.exec("update working_memory set session_id = 'elsewhere', channel_id = 'elsewhere'");
    db.close();

    await prepareWorkingBank(work, own, [other]);
    expect(read(work)).toEqual({ working: ["o1", "x1"], episodes: ["e-o1", "e-x1"], fts: ["o1", "x1"], sessions: ["default"] });

    retain(work, "n1");
    await commitWorkingBank(work, own);
    expect(existsSync(work)).toBe(false);
    expect(read(own)).toEqual({ working: ["n1", "o1"], episodes: ["e-n1", "e-o1"], fts: ["n1", "o1"], sessions: ["default"] });
    // The source is never written.
    expect(read(other).working).toEqual(["x1"]);
  });

  it("starts a session's bank from its first run, without what it was handed", async () => {
    const root = dir();
    const own = join(root, "s", "own.db");
    const other = join(root, "other.db");
    const work = join(root, "work.db");
    bank(other, [{ id: "x1", content: "memo other" }]);

    await prepareWorkingBank(work, own, [other]);
    expect(read(work).working).toEqual(["x1"]);
    retain(work, "n1");
    await commitWorkingBank(work, own);
    expect(read(own)).toMatchObject({ working: ["n1"], episodes: ["e-n1"], fts: ["n1"] });
  });

  it("lets mnemopi start the file when there is nothing yet", async () => {
    const root = dir();
    const own = join(root, "own.db");
    const work = join(root, "work.db");
    await prepareWorkingBank(work, own, [join(root, "missing.db")]);
    expect(existsSync(work)).toBe(false);
    retain(work, "n1");
    await commitWorkingBank(work, own);
    expect(read(own).working).toEqual(["n1"]);
  });

  it("keeps nothing for a session deleted during the run", async () => {
    const root = dir();
    const own = join(root, "own.db");
    const work = join(root, "work.db");
    await prepareWorkingBank(work, own, []);
    retain(work, "n1");
    await commitWorkingBank(work, own, false);
    expect(existsSync(own)).toBe(false);
    expect(existsSync(work)).toBe(false);
  });
});

describe("session memory", () => {
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const P = "00000000-0000-4000-8000-0000000000aa";

  it("recalls the banks the rules allow, and forgets a deleted session everywhere", async () => {
    const root = mkdtempSync(join(tmpdir(), "ucch-sm-"));
    const recallable: MemoryBankRef[] = [{ projectId: P, threadId: B }];
    const memory = new SessionMemory({
      memoriesDir: (subject) => join(root, subject, "omp", "memories"),
      allMemoriesDirs: async () => [join(root, "u1", "omp", "memories")],
      recallable: async () => recallable,
      exists: async () => true,
    });
    bank(memory.bankPath("u1", { projectId: P, threadId: B }), [{ id: "b1", content: "memo b" }]);

    const run = await memory.open({ subject: "u1", bank: { projectId: P, threadId: A }, runDir: root, key: "turn-1", text: "" });
    expect(read(run.path).working).toEqual(["b1"]);
    retain(run.path, "a1");
    await run.close();
    expect(read(memory.bankPath("u1", { projectId: P, threadId: A })).working).toEqual(["a1"]);

    await memory.forget({ projectId: P, threadId: B });
    const next = await memory.open({ subject: "u1", bank: { projectId: P, threadId: A }, runDir: root, key: "turn-2", text: "" });
    expect(read(next.path).working).toEqual(["a1"]);
    await next.close();
  });

  it("matches sessions by the words they share", () => {
    const a = sessionKeywords("Fix the Stripe webhook retries");
    expect(sharesKeyword(a, sessionKeywords("Stripe invoices"))).toBe(true);
    expect(sharesKeyword(a, sessionKeywords("Webhooks for GitHub"))).toBe(true);
    expect(sharesKeyword(a, sessionKeywords("Plan the trip to Lisbon"))).toBe(false);
    expect(sharesKeyword(sessionKeywords("New session"), sessionKeywords("New chat"))).toBe(false);
    expect(isPlaceholderTitle("Untitled")).toBe(true);
    expect(isPlaceholderTitle("Stripe webhook")).toBe(false);
  });
});
