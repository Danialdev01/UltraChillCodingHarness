import * as Y from "yjs";
import type { NoteDoc } from "@ucch/protocol";

/**
 * ProseMirror JSON in and out of a Yjs XML fragment, without a schema.
 *
 * The editor's Collaboration extension (`@tiptap/y-tiptap`) keeps a note as
 * an XML tree: an element per node, named after its type with its attributes
 * on it, and each run of text one `XmlText` whose formatting is the marks.
 * The collab service has to read and write that tree -- to seed it from
 * `notes.content` and to project it back -- and building the editor's schema
 * here would mean importing every extension the editor has, React node views
 * included. The encoding needs none of it, so this writes it directly; the
 * editor fills in default attributes when it reads a node, exactly as it
 * does for JSON. `prosemirror-y.test.ts` holds both directions to y-tiptap's.
 *
 * Marks are keyed by type name. y-tiptap hashes the key only for a mark type
 * that does not exclude itself (two comments overlapping, say); the notes
 * editor has none.
 */

interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

const isText = (node: PmNode) => node.type === "text";

/** Replaces everything in `fragment` with `doc`'s content. */
export function writeDocToFragment(fragment: Y.XmlFragment, doc: NoteDoc): void {
  const nodes = (doc.content ?? []) as PmNode[];
  fragment.doc!.transact(() => {
    if (fragment.length > 0) fragment.delete(0, fragment.length);
    fragment.insert(0, children(nodes));
  });
}

function children(nodes: PmNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (!isText(nodes[i]!)) {
      out.push(element(nodes[i]!));
      continue;
    }
    // A run of text nodes is one XmlText, its marks as formatting.
    const run: PmNode[] = [];
    while (i < nodes.length && isText(nodes[i]!)) run.push(nodes[i++]!);
    i--;
    const text = new Y.XmlText();
    text.applyDelta(run.map((node) => ({ insert: node.text ?? "", attributes: markAttributes(node) })));
    out.push(text);
  }
  return out;
}

function element(node: PmNode): Y.XmlElement {
  const el = new Y.XmlElement(node.type);
  for (const [key, value] of Object.entries(node.attrs ?? {})) {
    if (value !== null && value !== undefined && key !== "ychange") el.setAttribute(key, value as string);
  }
  el.insert(0, children(node.content ?? []));
  return el;
}

function markAttributes(node: PmNode): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const mark of node.marks ?? []) attributes[mark.type] = mark.attrs ?? {};
  return attributes;
}

/** The fragment as ProseMirror JSON: what `notes.content` holds. */
export function readDocFromFragment(fragment: Y.XmlFragment): NoteDoc {
  return { type: "doc", content: fragment.toArray().flatMap(serialise) };
}

function serialise(item: Y.XmlElement | Y.XmlText | Y.XmlHook): PmNode[] {
  if (item instanceof Y.XmlText) {
    return (item.toDelta() as { insert: unknown; attributes?: Record<string, Record<string, unknown>> }[])
      .filter((op) => typeof op.insert === "string")
      .map((op) => {
        const text: PmNode = { type: "text", text: op.insert as string };
        if (op.attributes) {
          text.marks = Object.entries(op.attributes).map(([key, attrs]) => {
            const mark: { type: string; attrs?: Record<string, unknown> } = { type: key.replace(/--[a-zA-Z0-9+/=]{8}$/, "") };
            if (attrs && Object.keys(attrs).length > 0) mark.attrs = attrs;
            return mark;
          });
        }
        return text;
      });
  }
  if (item instanceof Y.XmlElement) {
    const node: PmNode = { type: item.nodeName };
    const attrs = item.getAttributes();
    if (Object.keys(attrs).length > 0) node.attrs = attrs;
    const content = item.toArray().flatMap((child) => serialise(child as Y.XmlElement | Y.XmlText));
    if (content.length > 0) node.content = content;
    return [node];
  }
  return [];
}
