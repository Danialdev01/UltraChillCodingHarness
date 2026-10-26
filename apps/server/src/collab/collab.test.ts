import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { NoteDoc } from "@ucch/protocol";

import { NOTE_FIELD } from "./documents.js";
import { readDocFromFragment } from "./prosemirror-y.js";
import { createCollab, type Collab, type CollabAccess, type NoteDocuments } from "./server.js";

const NOTE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const paragraph = (text: string): NoteDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

/** `note_ydocs` and `notes.content`, in memory. */
function memoryNotes(initial: NoteDoc) {
  const row = { state: null as Uint8Array | null, content: initial, stores: 0 };
  const notes: NoteDocuments = {
    async load(noteId) {
      return noteId === NOTE ? { state: row.state, content: row.content } : null;
    },
    async seed(_noteId, state) {
      row.state ??= state;
      return row.state;
    },
    async store(_noteId, state, content) {
      row.state = state;
      row.content = content;
      row.stores++;
      return { projectId: PROJECT };
    },
  };
  return { row, notes };
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

let collab: Collab;
let port: number;
let memory: ReturnType<typeof memoryNotes>;
let announced: { projectId: string; noteId: string; userId?: string }[];
const providers: HocuspocusProvider[] = [];

/** Tickets that redeem: "good" for an editor, "viewer" for read-only. */
async function authorize(token: string): Promise<CollabAccess | null> {
  if (token === "good") return { userId: USER, projectId: PROJECT, readOnly: false };
  if (token === "viewer") return { userId: USER, projectId: PROJECT, readOnly: true };
  return null;
}

function client(token = "good", name = `note:${NOTE}`) {
  const document = new Y.Doc();
  let failed = false;
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name,
    token,
    document,
    onAuthenticationFailed: () => {
      failed = true;
    },
  });
  providers.push(provider);
  const text = () => {
    const doc = readDocFromFragment(document.getXmlFragment(NOTE_FIELD));
    return JSON.stringify(doc);
  };
  return { provider, document, text, failed: () => failed, synced: () => until(() => provider.isSynced) };
}

/** Types into the first paragraph's text, the way the editor's binding does. */
function typeAt(doc: Y.Doc, index: number, text: string) {
  const paragraphEl = doc.getXmlFragment(NOTE_FIELD).get(0) as Y.XmlElement;
  (paragraphEl.get(0) as Y.XmlText).insert(index, text);
}

beforeEach(async () => {
  memory = memoryNotes(paragraph("hello"));
  announced = [];
  collab = createCollab({
    secret: "s",
    authorize,
    notes: memory.notes,
    announce: async (projectId, noteId, userId) => void announced.push({ projectId, noteId, userId }),
    debounceMs: 50,
    maxDebounceMs: 200,
    idleUnloadMs: 300,
  });
  port = await collab.listen();
});

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await collab.destroy();
});

describe("the collab service", () => {
  it("seeds a note's document from its content, once", async () => {
    const a = client();
    await a.synced();
    expect(a.text()).toBe(JSON.stringify(paragraph("hello")));
    expect(memory.row.state).not.toBeNull();
  });

  it("merges two editors typing at once", async () => {
    const a = client();
    const b = client();
    await a.synced();
    await b.synced();
    typeAt(a.document, 0, "A");
    typeAt(b.document, 5, "B");
    await until(() => a.text() === b.text() && a.text().includes("A") && a.text().includes("B"));
    expect(a.text()).toBe(JSON.stringify(paragraph("AhelloB")));
  });

  it("projects the merge into the note's content, and announces it", async () => {
    const a = client();
    await a.synced();
    typeAt(a.document, 5, " world");
    await until(() => JSON.stringify(memory.row.content) === JSON.stringify(paragraph("hello world")));
    await until(() => announced.length > 0);
    expect(announced[0]).toEqual({ projectId: PROJECT, noteId: NOTE, userId: USER });
  });

  it("refuses a ticket the API does not vouch for, and a name that is not a document", async () => {
    const forged = client("forged");
    await until(() => forged.failed());
    const stranger = client("good", "note:../../etc");
    await until(() => stranger.failed());
    expect(collab.instance.getDocumentsCount()).toBe(0);
  });

  it("lets a viewer watch but not write", async () => {
    const editor = client();
    const viewer = client("viewer");
    await editor.synced();
    await viewer.synced();
    typeAt(viewer.document, 0, "X");
    typeAt(editor.document, 5, "!");
    await until(() => viewer.text().includes("!"));
    await new Promise((r) => setTimeout(r, 200));
    expect(editor.text()).toBe(JSON.stringify(paragraph("hello!")));
  });

  it("puts a write from outside the editor into every open editor, and saves it", async () => {
    const a = client();
    await a.synced();
    await collab.applyNote(NOTE, paragraph("rewritten"));
    await until(() => a.text() === JSON.stringify(paragraph("rewritten")));
    expect(memory.row.content).toEqual(paragraph("rewritten"));
    // The API's own write announces itself.
    expect(announced).toEqual([]);
  });

  it("unloads a document a while after its last editor leaves, saving first", async () => {
    const a = client();
    await a.synced();
    typeAt(a.document, 0, "bye ");
    a.provider.destroy();
    await new Promise((r) => setTimeout(r, 150));
    // Still held: a quick return finds it loaded.
    expect(collab.instance.getDocumentsCount()).toBe(1);
    await until(() => collab.instance.getDocumentsCount() === 0, 3000);
    expect(memory.row.content).toEqual(paragraph("bye hello"));
  });

  it("answers the API's calls only with the secret", async () => {
    const stats = await fetch(`http://127.0.0.1:${port}/internal/stats`, { headers: { "x-ucch-collab": "s" } });
    expect(await stats.json()).toEqual({ documents: 0, connections: 0 });
    expect((await fetch(`http://127.0.0.1:${port}/internal/stats`)).status).toBe(403);
    const write = await fetch(`http://127.0.0.1:${port}/internal/notes/${NOTE}/content`, {
      method: "PUT",
      headers: { "x-ucch-collab": "s", "content-type": "application/json" },
      body: JSON.stringify({ content: paragraph("over http") }),
    });
    expect(write.status).toBe(204);
    expect(memory.row.content).toEqual(paragraph("over http"));
  });
});
