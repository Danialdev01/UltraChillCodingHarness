/**
 * The tabs of a knowledge base's page. Plain module, like `manage-tabs.ts`: the server pages read `?tab=`
 * with these, and a function exported from a client component cannot be
 * called on the server.
 */

export const KNOWLEDGE_TABS = [
  { id: "documents", label: "Documents" },
  { id: "graph", label: "Knowledge graph" },
  { id: "search", label: "Search" },
] as const

export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number]["id"]

/** The tab a `?tab=` value names, or Documents for anything else. */
export function knowledgeTabOf(value: string | string[] | undefined): KnowledgeTab {
  const raw = Array.isArray(value) ? value[0] : value
  return KNOWLEDGE_TABS.find((t) => t.id === raw)?.id ?? "documents"
}
