import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from "@tiptap/y-tiptap";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { NoteDoc } from "@ucch/protocol";

import { readDocFromFragment, writeDocToFragment } from "./prosemirror-y.js";

const DOC: NoteDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Plan" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Ship " },
        { type: "text", text: "today", marks: [{ type: "bold" }] },
        { type: "text", text: ", see " },
        { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.com" } }, { type: "italic" }] },
      ],
    },
    {
      type: "bulletList",
      content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }],
    },
    { type: "paragraph" },
  ],
};

const schema = getSchema([StarterKit]);

/** What the editor's own binding writes for a document. */
function editorEncoding(doc: NoteDoc): Y.Doc {
  return prosemirrorJSONToYDoc(schema, doc, "default");
}

describe("ProseMirror JSON <-> Yjs", () => {
  it("writes the tree the editor writes", () => {
    const ours = new Y.Doc();
    writeDocToFragment(ours.getXmlFragment("default"), DOC);
    // The editor fills in default attributes; read both the editor's way and compare as the editor sees them.
    const theirs = editorEncoding(DOC);
    const read = (doc: Y.Doc) => schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("default"))).toJSON();
    expect(read(ours)).toEqual(read(theirs));
  });

  it("reads what the editor wrote as the editor would", () => {
    const theirs = editorEncoding(DOC);
    // Equal as nodes: y-tiptap's reader also keeps an empty `attrs: {}` on
    // marks that have none, which parses to the same mark.
    const ours = schema.nodeFromJSON(readDocFromFragment(theirs.getXmlFragment("default")));
    expect(ours.eq(schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(theirs.getXmlFragment("default"))))).toBe(true);
    expect(ours.eq(schema.nodeFromJSON(DOC))).toBe(true);
  });

  it("round-trips a document to the same content", () => {
    const doc = new Y.Doc();
    writeDocToFragment(doc.getXmlFragment("default"), DOC);
    const back = readDocFromFragment(doc.getXmlFragment("default"));
    expect(schema.nodeFromJSON(back).eq(schema.nodeFromJSON(DOC))).toBe(true);
  });

  it("replaces what was there, in one transaction", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("default");
    writeDocToFragment(fragment, DOC);
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    writeDocToFragment(fragment, { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }] });
    expect(transactions).toBe(1);
    expect(readDocFromFragment(fragment)).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "new" }] }],
    });
  });

  it("reads an empty document", () => {
    expect(readDocFromFragment(new Y.Doc().getXmlFragment("default"))).toEqual({ type: "doc", content: [] });
  });
});
