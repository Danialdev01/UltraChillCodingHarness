import type {
  KnowledgeGraph,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgeHit,
  KnowledgeScope,
} from "@ucch/protocol";
import type { KnowledgeDocumentGraph } from "@ucch/db";

/**
 * The pure half of knowledge bases: building a document's slice of the
 * graph, merging the slices into a base's graph, and finding the passages
 * and facts a message needs. No I/O, so every rule here is testable alone.
 */

/** The most entities and relations one document contributes. */
export const MAX_DOC_ENTITIES = 60;
export const MAX_DOC_RELATIONS = 120;

/** The text a model is shown to extract a graph from: the head of the document. */
export const GRAPH_SAMPLE_CHARS = 24_000;

export const GRAPH_PROMPT = [
  "You build a knowledge graph from a document. Read it and return ONLY a JSON object, no prose and no code fence:",
  '{"entities":[{"name":"...","type":"...","description":"..."}],"relations":[{"source":"...","target":"...","relation":"..."}]}',
  "Rules:",
  "- entities: the people, organisations, places, concepts, products, technologies, events, laws, terms and works the document is about. Use the most specific common name. type is one lowercase word (person, organization, concept, technology, place, event, product, term, work, other). description is one short sentence from the document.",
  `- At most ${MAX_DOC_ENTITIES} entities, the most important first.`,
  "- relations: facts the document states between two of your entities, source and target spelled exactly as in entities. relation is a short lowercase verb phrase (\"is part of\", \"depends on\", \"was founded by\").",
  `- At most ${MAX_DOC_RELATIONS} relations. Do not invent anything the document does not say.`,
].join("\n");

/** The identity of an entity within a base: case, spacing and punctuation folded. */
export function entityKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’'"`]/g, "")
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const clip = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";

/**
 * A model's answer read as a graph, or null when there is no JSON object in
 * it. Tolerant of a code fence, prose around the object, and stray fields;
 * strict about what survives: names present, relations between known entities.
 */
export function parseGraphJson(text: string): KnowledgeDocumentGraph | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const { entities, relations } = raw as { entities?: unknown; relations?: unknown };
  return cleanGraph({
    entities: Array.isArray(entities)
      ? entities.map((e) => ({
          name: clip((e as { name?: unknown })?.name, 120),
          type: clip((e as { type?: unknown })?.type, 30).toLowerCase() || "other",
          description: clip((e as { description?: unknown })?.description, 300),
        }))
      : [],
    relations: Array.isArray(relations)
      ? relations.map((r) => ({
          source: clip((r as { source?: unknown })?.source, 120),
          target: clip((r as { target?: unknown })?.target, 120),
          relation: clip((r as { relation?: unknown })?.relation, 60).toLowerCase() || "related to",
        }))
      : [],
  });
}

/** Drops nameless entities, duplicates, self-loops and relations to unknown entities; applies the caps. */
export function cleanGraph(graph: KnowledgeDocumentGraph): KnowledgeDocumentGraph {
  const seen = new Map<string, KnowledgeDocumentGraph["entities"][number]>();
  for (const entity of graph.entities) {
    const key = entityKey(entity.name);
    if (!key || seen.has(key)) continue;
    seen.set(key, entity);
    if (seen.size >= MAX_DOC_ENTITIES) break;
  }
  const relations: KnowledgeDocumentGraph["relations"] = [];
  const pairs = new Set<string>();
  for (const relation of graph.relations) {
    const source = entityKey(relation.source);
    const target = entityKey(relation.target);
    if (!seen.has(source) || !seen.has(target) || source === target) continue;
    const id = `${source}\u0000${relation.relation}\u0000${target}`;
    if (pairs.has(id)) continue;
    pairs.add(id);
    relations.push(relation);
    if (relations.length >= MAX_DOC_RELATIONS) break;
  }
  return { entities: [...seen.values()], relations };
}

// ---- Heuristic graph ----------------------------------------------------------

const STOP = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its " +
    "may me might more most must my no not of on or our she should so some such than that the their them then there these " +
    "they this those to too us was we were what when where which while who why will with would you your also each other " +
    "about after again all any because before being below between both during few further here just only own same through " +
    "under until up very via over out off once however therefore thus figure table chapter section page note example"
  ).split(" "),
);

/**
 * A graph without a model: entities are headings and repeated proper-noun
 * phrases, relations are entities named in the same sentence. Shallower than
 * a model's, but free, instant, and better than no graph when no key is set.
 */
export function heuristicGraph(text: string): KnowledgeDocumentGraph {
  const counts = new Map<string, { name: string; count: number; heading: boolean; sentence: string }>();
  const add = (name: string, heading: boolean, sentence: string) => {
    const trimmed = name.trim().replace(/[.,:;]+$/, "");
    const key = entityKey(trimmed);
    if (!key || key.length < 3 || STOP.has(key) || /^\d+$/.test(key)) return;
    const current = counts.get(key);
    if (current) {
      current.count += 1;
      current.heading ||= heading;
    } else counts.set(key, { name: trimmed, count: 1, heading, sentence });
  };

  for (const match of text.matchAll(/^#{1,4}\s+(.{3,80})$/gm)) add(match[1]!, true, "");

  const sentences = text.split(/(?<=[.!?])\s+|\n{2,}/).slice(0, 4_000);
  const sentenceEntities: string[][] = [];
  const phrase = /\b(?:[A-Z][\p{L}\p{N}&-]*|[A-Z]{2,}\d*)(?:\s+(?:of|the|and|for|de)?\s*[A-Z][\p{L}\p{N}&-]*){0,4}/gu;
  for (const sentence of sentences) {
    const found: string[] = [];
    for (const match of sentence.matchAll(phrase)) {
      const words = match[0].split(/\s+/);
      // A lone capitalised word that starts the sentence is just grammar.
      if (words.length === 1 && match.index === sentence.search(/\S/) && !/^[A-Z]{2,}/.test(match[0])) continue;
      add(match[0], false, sentence.trim().slice(0, 300));
      found.push(entityKey(match[0]));
    }
    sentenceEntities.push(found);
  }

  const ranked = [...counts.entries()]
    .filter(([, v]) => v.heading || v.count >= 2)
    .sort((a, b) => Number(b[1].heading) - Number(a[1].heading) || b[1].count - a[1].count)
    .slice(0, MAX_DOC_ENTITIES);
  const kept = new Map(ranked);

  const together = new Map<string, number>();
  for (const found of sentenceEntities) {
    const unique = [...new Set(found.filter((k) => kept.has(k)))];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const [a, b] = [unique[i]!, unique[j]!].sort();
        const id = `${a}\u0000${b}`;
        together.set(id, (together.get(id) ?? 0) + 1);
      }
    }
  }
  const relations = [...together.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DOC_RELATIONS)
    .map(([id]) => {
      const [a, b] = id.split("\u0000") as [string, string];
      return { source: kept.get(a)!.name, target: kept.get(b)!.name, relation: "mentioned with" };
    });

  return {
    entities: ranked.map(([, v]) => ({
      name: v.name,
      type: v.heading ? "topic" : "concept",
      description: v.sentence,
    })),
    relations,
  };
}

// ---- Merging -----------------------------------------------------------------

/** The base's graph: every document's slice, folded by entity key. */
export function mergeGraphs(documents: readonly { id: string; graph: KnowledgeDocumentGraph | null }[]): KnowledgeGraph {
  const nodes = new Map<string, KnowledgeGraphNode & { types: Map<string, number> }>();
  const edges = new Map<string, KnowledgeGraphEdge>();

  for (const doc of documents) {
    if (!doc.graph) continue;
    for (const entity of doc.graph.entities) {
      const id = entityKey(entity.name);
      if (!id) continue;
      let node = nodes.get(id);
      if (!node) {
        node = { id, name: entity.name, type: entity.type, description: entity.description, documentIds: [], degree: 0, types: new Map() };
        nodes.set(id, node);
      }
      if (!node.documentIds.includes(doc.id)) node.documentIds.push(doc.id);
      if (!node.description && entity.description) node.description = entity.description;
      node.types.set(entity.type, (node.types.get(entity.type) ?? 0) + 1);
    }
    for (const relation of doc.graph.relations) {
      const source = entityKey(relation.source);
      const target = entityKey(relation.target);
      if (!nodes.has(source) || !nodes.has(target) || source === target) continue;
      const id = `${source}\u0000${relation.relation}\u0000${target}`;
      const edge = edges.get(id);
      if (edge) {
        edge.weight += 1;
        if (!edge.documentIds.includes(doc.id)) edge.documentIds.push(doc.id);
      } else {
        edges.set(id, { source, target, relation: relation.relation, documentIds: [doc.id], weight: 1 });
      }
    }
  }

  for (const edge of edges.values()) {
    nodes.get(edge.source)!.degree += 1;
    nodes.get(edge.target)!.degree += 1;
  }
  return {
    nodes: [...nodes.values()].map(({ types, ...node }) => ({
      ...node,
      // The type most documents gave it.
      type: [...types.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? node.type,
    })),
    edges: [...edges.values()],
  };
}

// ---- Search -----------------------------------------------------------------

export interface Chunk {
  documentId: string;
  documentName: string;
  baseId: string;
  baseName: string;
  text: string;
}

/** Splits a document into overlapping passages, on paragraph boundaries where it can. */
export function chunkText(text: string, size = 1_400, overlap = 200): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const para = clean.lastIndexOf("\n\n", end);
      const stop = clean.lastIndexOf(". ", end);
      const cut = para > start + size / 2 ? para : stop > start + size / 2 ? stop + 1 : end;
      end = cut;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function terms(text: string): string[] {
  return (text.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !STOP.has(t));
}

/** BM25 over the passages, best first. Passages with no query term are left out. */
export function rankChunks(query: string, chunks: readonly Chunk[], limit: number): KnowledgeHit[] {
  const q = [...new Set(terms(query))];
  if (q.length === 0 || chunks.length === 0) return [];
  const docs = chunks.map((c) => terms(c.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.4;
  const b = 0.75;
  const scored = docs.map((d, i) => {
    const tf = new Map<string, number>();
    for (const t of d) if (df.has(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const [t, f] of tf) {
      const n = df.get(t)!;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return { i, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ i, score }) => {
      const c = chunks[i]!;
      return {
        baseId: c.baseId,
        baseName: c.baseName,
        documentId: c.documentId,
        documentName: c.documentName,
        text: c.text,
        score: Math.round(score * 100) / 100,
      };
    });
}

/**
 * The graph's facts about what the message names: every entity whose name
 * the message contains (or shares rare words with), and the relations that
 * touch them, as sentences a model can read.
 */
export function relevantFacts(query: string, graph: KnowledgeGraph, limit = 40): string[] {
  const q = ` ${entityKey(query)} `;
  const qTerms = new Set(terms(query));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const hit = new Set<string>();
  for (const node of graph.nodes) {
    if (node.id.length >= 3 && q.includes(` ${node.id} `)) hit.add(node.id);
    else {
      const words = terms(node.name);
      if (words.length > 0 && words.every((w) => qTerms.has(w))) hit.add(node.id);
    }
  }
  const facts: string[] = [];
  for (const id of hit) {
    const node = byId.get(id)!;
    if (node.description) facts.push(`${node.name} (${node.type}): ${node.description}`);
  }
  const edges = graph.edges
    .filter((e) => hit.has(e.source) || hit.has(e.target))
    .sort((a, b) => b.weight - a.weight);
  for (const edge of edges) {
    facts.push(`${byId.get(edge.source)!.name} —${edge.relation}→ ${byId.get(edge.target)!.name}`);
    if (facts.length >= limit) break;
  }
  return facts.slice(0, limit);
}

// ---- The turn's prompt ------------------------------------------------------

export interface KnowledgeContext {
  scope: KnowledgeScope;
  bases: { name: string; description: string; dir: string; documents: string[] }[];
  hits: KnowledgeHit[];
  facts: string[];
}

/** The most characters of passages put in front of the model. */
export const MAX_INJECTED_CHARS = 18_000;

/**
 * What a knowledge turn is told before the message: which bases, where their
 * text is on disk, the passages and graph facts the search found -- and, for
 * `knowledge`, that the bases are the only source it may use.
 */
export function knowledgePrompt(context: KnowledgeContext): string {
  const lines: string[] = ["<knowledge_bases>"];
  lines.push(
    context.scope === "knowledge"
      ? "Answer ONLY from the knowledge bases below. Do not search or fetch anything from the web -- web tools are switched off for this turn. If the bases do not contain the answer, say so plainly rather than answering from memory."
      : "Answer from the knowledge bases below first. You may also search the web to fill gaps or check for newer information; say which parts came from the web.",
  );
  lines.push("Cite the document a fact came from by its name, e.g. [handbook.pdf].");
  lines.push("");
  for (const base of context.bases) {
    lines.push(`Base "${base.name}"${base.description ? ` -- ${base.description}` : ""}`);
    lines.push(`  Text of every document: ${base.dir}/ (an absolute path outside the project, read-only: one .md per document, plus graph.json). Search it with grep and read it with your file tools by that full path when the passages below are not enough; do not copy it into the project.`);
    const shown = base.documents.slice(0, 40);
    lines.push(`  Documents: ${shown.join(", ")}${base.documents.length > shown.length ? `, and ${base.documents.length - shown.length} more` : ""}`);
  }
  if (context.facts.length > 0) {
    lines.push("", "Knowledge graph facts about what the message names:");
    for (const fact of context.facts) lines.push(`- ${fact}`);
  }
  if (context.hits.length > 0) {
    lines.push("", "Passages that match the message, best first:");
    let used = 0;
    for (const hit of context.hits) {
      if (used + hit.text.length > MAX_INJECTED_CHARS) break;
      used += hit.text.length;
      lines.push(`<passage base="${hit.baseName}" document="${hit.documentName}">`, hit.text, "</passage>");
    }
  } else {
    lines.push("", "No passage matched the message's words directly; search the files above.");
  }
  lines.push("</knowledge_bases>");
  return lines.join("\n");
}

/** A file name safe on disk: the last path segment, its readable part kept. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]+/gu, "_").replace(/^\.+/, "").trim().slice(0, 100);
  return cleaned || "document";
}
