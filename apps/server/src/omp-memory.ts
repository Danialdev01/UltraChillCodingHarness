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
 * Session-scoped memory (the workspace's Harness settings). mnemopi reads
 * one SQLite bank per run and recalls a row only when its `session_id` is
 * the run's bank name ("default"), so which sessions a run remembers is
 * decided by what is in the file it is handed:
 *
 * - every session keeps its own bank, which only its runs write;
 * - a run gets a working copy of that bank with the rows of every session
 *   it may recall added, renamed into the run's bank, and remembered as
 *   imported (`ucch_imported`);
 * - when the run ends, only the rows it added -- past the snapshot taken
 *   before it started (`ucch_snapshot`) -- go back into its own bank, so
 *   an imported memory is never stored twice, and a bank that is deleted
 *   takes its memories out of every later run.
 *
 * Generic over tables, so a mnemopi upgrade's new tables and columns come
 * along: each regular table is copied by its shared columns, an integer
 * primary key left for the target to number. FTS indexes follow through
 * mnemopi's own triggers.
 */

const BANK_SESSION = "default";

interface TableInfo {
  name: string;
  columns: string[];
  /** The column that is the rowid (an `INTEGER PRIMARY KEY`), left out of a copy. */
  rowidAlias: string | null;
}

type Db = InstanceType<typeof import("node:sqlite").DatabaseSync>;

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The tables rows live in: no SQLite internals, FTS shadows, virtual tables or bookkeeping of ours. */
function dataTables(db: Db, schema = "main"): Map<string, TableInfo> {
  const rows = db
    .prepare(`select name, sql from ${quoteId(schema)}.sqlite_master where type = 'table'`)
    .all() as { name: string; sql: string | null }[];
  const virtual = rows.filter((row) => /^\s*create\s+virtual\s+table/i.test(row.sql ?? "")).map((row) => row.name);
  const tables = new Map<string, TableInfo>();
  for (const row of rows) {
    if (row.name.startsWith("sqlite_") || row.name.startsWith("ucch_")) continue;
    if (virtual.includes(row.name) || virtual.some((name) => row.name.startsWith(`${name}_`))) continue;
    if (/without\s+rowid/i.test(row.sql ?? "")) continue;
    const info = db.prepare(`pragma ${quoteId(schema)}.table_info(${quoteId(row.name)})`).all() as {
      name: string;
      type: string;
      pk: number;
    }[];
    const keys = info.filter((column) => column.pk > 0);
    const rowidAlias = keys.length === 1 && keys[0]!.type.toUpperCase() === "INTEGER" ? keys[0]!.name : null;
    tables.set(row.name, { name: row.name, columns: info.map((column) => column.name), rowidAlias });
  }
  return tables;
}

function maxRowid(db: Db, table: string): number {
  const row = db.prepare(`select coalesce(max(rowid), 0) as n from ${quoteId(table)}`).get() as { n: number | bigint };
  return Number(row.n);
}

/**
 * Brings `main` up to the attached `from`'s schema: the tables, indexes and
 * triggers it lacks, and the columns its tables lack. A bank written by an
 * older mnemopi then keeps what a newer one retained.
 */
function syncSchema(db: Db, from: string): void {
  const objects = db
    .prepare(`select type, name, tbl_name, sql from ${quoteId(from)}.sqlite_master where sql is not null`)
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  const have = new Set(
    (db.prepare("select name from main.sqlite_master").all() as { name: string }[]).map((row) => row.name),
  );
  const order = ["table", "index", "trigger", "view"];
  const virtual = objects.filter((o) => o.type === "table" && /^\s*create\s+virtual/i.test(o.sql)).map((o) => o.name);
  for (const type of order) {
    for (const object of objects) {
      if (object.type !== type || have.has(object.name)) continue;
      if (object.name.startsWith("sqlite_") || object.tbl_name.startsWith("ucch_")) continue;
      // An FTS table makes its own shadow tables.
      if (type === "table" && virtual.some((name) => object.name.startsWith(`${name}_`))) continue;
      db.exec(object.sql);
      have.add(object.name);
    }
  }
  const mine = dataTables(db);
  for (const [name, theirs] of dataTables(db, from)) {
    const ours = mine.get(name);
    if (!ours) continue;
    const columns = db.prepare(`pragma ${quoteId(from)}.table_info(${quoteId(name)})`).all() as {
      name: string;
      type: string;
      dflt_value: string | null;
    }[];
    for (const column of columns) {
      if (ours.columns.includes(column.name) || !theirs.columns.includes(column.name)) continue;
      const fallback = column.dflt_value === null ? "" : ` default ${column.dflt_value}`;
      db.exec(`alter table ${quoteId(name)} add column ${quoteId(column.name)} ${column.type}${fallback}`);
    }
  }
}

/**
 * Copies `from`'s rows of every table both have into `main`, keeping a row
 * whose key `main` already holds. `where` narrows the rows read (a clause
 * on `rowid` and `t`, the table's name). Returns, per table, the rowid
 * before the copy: what is past it in `main` is what the copy added.
 */
function copyRows(db: Db, from: string, where?: (table: string) => string): Map<string, number> {
  const before = new Map<string, number>();
  const mine = dataTables(db);
  for (const [name, theirs] of dataTables(db, from)) {
    const ours = mine.get(name);
    if (!ours) continue;
    const columns = ours.columns.filter((column) => theirs.columns.includes(column) && column !== ours.rowidAlias);
    if (columns.length === 0) continue;
    const list = columns.map(quoteId).join(", ");
    before.set(name, maxRowid(db, name));
    const filter = where ? ` where ${where(name)}` : "";
    db.exec(`insert or ignore into main.${quoteId(name)} (${list}) select ${list} from ${quoteId(from)}.${quoteId(name)}${filter}`);
  }
  return before;
}

function attach(db: Db, path: string, alias: string): void {
  db.exec(`attach database ${quoteText(path)} as ${quoteId(alias)}`);
}

async function removeBankFiles(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(`${path}${suffix}`, { force: true });
}

async function exists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises");
  return stat(path).then((info) => info.isFile() && info.size > 0, () => false);
}

/** A consistent copy of a bank, WAL included, at `to`. */
function copyBank(from: string, to: string): void {
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    db.exec(`vacuum into ${quoteText(to)}`);
  } finally {
    db.close();
  }
}

/**
 * Writes a run's working bank at `work`: a copy of the session's own bank
 * (`own`, absent before its first memory) with the rows of `sources` --
 * the other sessions it may recall -- added as imported. With no bank at
 * all nothing is written, and mnemopi starts the file itself.
 */
export async function prepareWorkingBank(work: string, own: string, sources: readonly string[]): Promise<void> {
  await removeBankFiles(work);
  const present: string[] = [];
  for (const source of sources) if (source !== own && (await exists(source))) present.push(source);
  const ownExists = await exists(own);
  if (!ownExists && present.length === 0) return;

  const base = ownExists ? own : present.shift()!;
  copyBank(base, work);
  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(work);
  try {
    db.exec("create table ucch_imported (tbl text not null, rid integer not null, primary key (tbl, rid))");
    db.exec("create table ucch_snapshot (tbl text primary key, maxrid integer not null)");
    const markFrom = (table: string, after: number) =>
      db.exec(
        `insert or ignore into ucch_imported (tbl, rid) select ${quoteText(table)}, rowid from ${quoteId(table)} where rowid > ${after}`,
      );
    // Nothing of its own yet: the copy it started from is someone else's.
    if (!ownExists) for (const table of dataTables(db).keys()) markFrom(table, 0);
    present.forEach((source, index) => {
      const alias = `src${index}`;
      attach(db, source, alias);
      try {
        for (const [table, before] of copyRows(db, alias)) markFrom(table, before);
      } finally {
        db.exec(`detach database ${quoteId(alias)}`);
      }
    });
    // Recalled as the run's own: mnemopi reads its bank's session alone.
    for (const table of dataTables(db).values()) {
      for (const column of ["session_id", "channel_id"]) {
        if (!table.columns.includes(column)) continue;
        db.exec(
          `update ${quoteId(table.name)} set ${quoteId(column)} = ${quoteText(BANK_SESSION)} where rowid in (select rid from ucch_imported where tbl = ${quoteText(table.name)})`,
        );
      }
    }
    for (const table of dataTables(db).keys()) {
      db.exec(`insert into ucch_snapshot (tbl, maxrid) values (${quoteText(table)}, ${maxRowid(db, table)})`);
    }
  } finally {
    db.close();
  }
}

const commits = new Map<string, Promise<void>>();

/**
 * Puts what a run retained into its session's bank and removes the working
 * copy. Only rows past the snapshot go back; one run's commit waits for
 * another's on the same bank. `keep` false -- the session was deleted
 * meanwhile -- drops it all.
 */
export async function commitWorkingBank(work: string, own: string, keep = true): Promise<void> {
  const previous = commits.get(own) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => commitNow(work, own, keep));
  commits.set(own, next);
  try {
    await next;
  } finally {
    if (commits.get(own) === next) commits.delete(own);
  }
}

async function commitNow(work: string, own: string, keep: boolean): Promise<void> {
  try {
    if (!keep || !(await exists(work))) return;
    const { DatabaseSync } = sqlite();
    const snapshot = new Map<string, number>();
    {
      const db = new DatabaseSync(work);
      try {
        const hasSnapshot = db.prepare("select 1 from sqlite_master where name = 'ucch_snapshot'").get();
        if (hasSnapshot) {
          for (const row of db.prepare("select tbl, maxrid from ucch_snapshot").all() as { tbl: string; maxrid: number | bigint }[]) {
            snapshot.set(row.tbl, Number(row.maxrid));
          }
        }
        // Into the main file, so the copy below needs no WAL beside it.
        db.exec("pragma wal_checkpoint(truncate)");
      } finally {
        db.close();
      }
    }
    const added = (table: string) => `rowid > ${snapshot.get(table) ?? 0}`;
    const { mkdir, rename } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(own), { recursive: true, mode: 0o700 });
    if (!(await exists(own))) {
      // Its first memories: the working copy, less everything it was handed.
      const fresh = `${own}.new`;
      await removeBankFiles(fresh);
      copyBank(work, fresh);
      const db = new DatabaseSync(fresh);
      try {
        for (const table of dataTables(db).keys()) db.exec(`delete from ${quoteId(table)} where not (${added(table)})`);
        db.exec("drop table if exists ucch_imported");
        db.exec("drop table if exists ucch_snapshot");
        db.exec("vacuum");
      } finally {
        db.close();
      }
      await rename(fresh, own);
      return;
    }
    const db = new DatabaseSync(own);
    try {
      attach(db, work, "work");
      try {
        db.exec("begin immediate");
        try {
          syncSchema(db, "work");
          copyRows(db, "work", added);
          db.exec("commit");
        } catch (error) {
          db.exec("rollback");
          throw error;
        }
      } finally {
        db.exec("detach database work");
      }
    } finally {
      db.close();
    }
  } finally {
    await removeBankFiles(work);
  }
}
