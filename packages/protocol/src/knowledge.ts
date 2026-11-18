import { z } from "zod";

/**
 * Knowledge bases: a session workspace's folders of documents, each with a
 * knowledge graph built from what its documents say.
 *
 * A chat picks any of the workspace's bases for a message, and how far the
 * agent may look beyond them: `knowledge` keeps it to the bases alone (the
 * "search by book" setting -- no web tools at all), `web` lets it search the
 * web as well, with the bases still read first.
 */

export const KnowledgeScope = z.enum(["knowledge", "web"]);
export type KnowledgeScope = z.infer<typeof KnowledgeScope>;

/** The most bases one message can carry. */
export const MAX_MESSAGE_KNOWLEDGE_BASES = 8;

/** What a message asks of the knowledge bases, on `thread.send`. */
export const MessageKnowledge = z.object({
  baseIds: z.array(z.string().uuid()).min(1).max(MAX_MESSAGE_KNOWLEDGE_BASES),
  scope: KnowledgeScope.default("knowledge"),
});
export type MessageKnowledge = z.infer<typeof MessageKnowledge>;

export const KnowledgeBaseCreate = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
});
export type KnowledgeBaseCreate = z.infer<typeof KnowledgeBaseCreate>;

export const KnowledgeBaseUpdate = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2_000).optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, { message: "nothing to change" });
export type KnowledgeBaseUpdate = z.infer<typeof KnowledgeBaseUpdate>;

/** Where a document is on its way to being searchable and in the graph. */
export type KnowledgeDocumentStatus = "processing" | "ready" | "failed";

export interface KnowledgeBaseSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  documentCount: number;
  /** Bytes of the originals. */
  totalBytes: number;
  /** Entities in the merged graph. */
  entityCount: number;
  relationCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocumentSummary {
  id: string;
  baseId: string;
  name: string;
  mediaType: string;
  size: number;
  status: KnowledgeDocumentStatus;
  /** Why it failed, or a warning from reading it. */
  error: string | null;
  /** Characters of text read out of it. */
  textLength: number;
  entityCount: number;
  relationCount: number;
  /** How its graph was made: by a model, or by the local fallback. */
  graphSource: "model" | "heuristic" | null;
  createdAt: string;
}

/** One entity in a base's graph, merged across its documents. */
export interface KnowledgeGraphNode {
  /** The normalised name: the node's identity within the base. */
  id: string;
  name: string;
  type: string;
  description: string;
  /** The documents that mention it. */
  documentIds: string[];
  /** How many relations touch it. */
  degree: number;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  relation: string;
  documentIds: string[];
  weight: number;
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

/** One passage a search found. */
export interface KnowledgeHit {
  baseId: string;
  baseName: string;
  documentId: string;
  documentName: string;
  text: string;
  score: number;
}
