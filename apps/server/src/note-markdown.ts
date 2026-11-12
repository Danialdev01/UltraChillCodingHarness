import { createHash } from "node:crypto";
import { marked, type Token } from "marked";
import type { NoteDoc } from "@ucch/protocol";

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string; marks?: { type: string; attrs?: Record<string, unknown> }[] };

/** Parse ordinary GFM plus lossless rich blocks. Unknown HTML is kept as text. */
export function markdownToNote(markdown: string): NoteDoc {
  const preserved = new Map<string, Node[]>();
  markdown = markdown.replace(/<!-- ucch-block:([A-Za-z0-9+/=]+) -->\n([\s\S]*?)\n<!-- \/ucch-block -->/g, (_all, encoded: string, body: string) => {
    const snapshot = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const nodes = snapshot.hash === hash(body) ? [snapshot.node] : markdownToNote(body).content as Node[];
    const key = `ucch-preserved-${preserved.size}`;
    preserved.set(key, nodes);
    return `\n\n\`\`\`${key}\n\`\`\`\n\n`;
  });
  const inline = (tokens: Token[] = []): Node[] => tokens.flatMap((t): Node[] => {
    const token = t as any;
    const marks: Record<string, string> = { strong: "bold", em: "italic", del: "strike", codespan: "code" };
    if (marks[t.type] || t.type === "link") {
      const children: Node[] = token.tokens ? inline(token.tokens) : [{ type: "text", text: token.text }];
      return children.map(n => ({ ...n, marks: [...(n.marks ?? []), t.type === "link" ? { type: "link", attrs: { href: token.href } } : { type: marks[t.type]! }] }));
    }
    if (t.type === "br") return [{ type: "hardBreak" }];
    if (t.type === "image") return [{ type: "image", attrs: { src: token.href, alt: token.text, title: token.title } }];
    if (token.tokens) return inline(token.tokens);
    return token.text || token.raw ? [{ type: "text", text: token.text ?? token.raw }] : [];
  });
  const blocks = (tokens: Token[]): Node[] => tokens.flatMap((t): Node[] => {
    const token = t as any;
    switch (t.type) {
      case "space": return [];
      case "heading": return [{ type: "heading", attrs: { level: token.depth }, content: inline(token.tokens) }];
      case "paragraph": case "text": {
        const nodes = inline(token.tokens ?? [{ type: "text", text: token.text }]);
        if (nodes.length === 1 && nodes[0]?.type === "image") return nodes;
        return [{ type: "paragraph", content: nodes }];
      }
      case "hr": return [{ type: "horizontalRule" }];
      case "blockquote": return [{ type: "blockquote", content: blocks(token.tokens) }];
      case "code": {
        if (preserved.has(token.lang)) return preserved.get(token.lang)!;
        if (token.lang === "ucch-node") {
          const node = JSON.parse(token.text);
          if (!node || typeof node.type !== "string") throw new Error("Invalid ucch-node block");
          return [node];
        }
        if (token.lang === "mermaid") return [{ type: "mermaid", attrs: { code: token.text } }];
        return [{ type: "codeBlock", attrs: { language: token.lang || null }, content: token.text ? [{ type: "text", text: token.text }] : [] }];
      }
      case "list": {
        const task = token.items.some((item: any) => item.task);
        return [{ type: task ? "taskList" : token.ordered ? "orderedList" : "bulletList", ...(token.ordered ? { attrs: { start: token.start } } : {}), content: token.items.map((item: any) => ({ type: task ? "taskItem" : "listItem", ...(task ? { attrs: { checked: !!item.checked } } : {}), content: blocks(item.tokens) })) }];
      }
      case "table": return [{ type: "table", content: [token.header, ...token.rows].map((row: any[], i: number) => ({ type: "tableRow", content: row.map(cell => ({ type: i === 0 ? "tableHeader" : "tableCell", content: [{ type: "paragraph", content: inline(cell.tokens) }] })) })) }];
      default: return [{ type: "paragraph", content: [{ type: "text", text: token.raw }] }];
    }
  });
  return { type: "doc", content: blocks(marked.lexer(markdown)) };
}

/** Plain blocks stay readable; unsupported attributes/nodes use an editable JSON fence. */
export function richMarkdown(doc: NoteDoc, render: (doc: NoteDoc) => string): string {
  return (doc.content ?? []).map(raw => {
    const node = raw as Node;
    const one: NoteDoc = { type: "doc", content: [node] };
    const md = render(one);
    // Only use Markdown when it round trips exactly. This also preserves custom marks,
    // table attributes, empty paragraphs and drawings without silently flattening them.
    if (canonical(markdownToNote(md).content?.[0]) === canonical(node)) return md;
    if (["paragraph", "heading", "bulletList", "orderedList", "taskList", "blockquote", "codeBlock", "image", "table", "horizontalRule"].includes(node.type) && md) {
      const snapshot = Buffer.from(JSON.stringify({ hash: hash(md), node })).toString("base64");
      return `<!-- ucch-block:${snapshot} -->\n${md}\n<!-- /ucch-block -->`;
    }
    const json = JSON.stringify(node, null, 2);
    const fence = "`".repeat(Math.max(3, ...Array.from(json.matchAll(/`+/g), m => m[0].length + 1)));
    return `${fence}ucch-node\n${json}\n${fence}`;
  }).join("\n\n");
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
}

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
