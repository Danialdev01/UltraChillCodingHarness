/**
 * How the Usage cards decide which models to name.
 *
 * A card has room for three rows and a workspace can run a dozen models, so
 * the rest are summed into one line. Which three that is differs per card --
 * a cheap model answering constantly is top of Requests and bottom of Spend
 * -- so ranking is done per metric rather than once for the tab.
 */

/** A model's figures, as the API returns them. */
export interface ModelUsage {
  /** Null on turns recorded before the model was stored with them. */
  model: string | null;
  costUsd: number;
  requests: number;
  tokens: number;
}

/** One line under a card's headline figure. */
export interface BreakdownRow {
  /** The model id, or null for the summed remainder and for unknown turns. */
  model: string | null;
  value: number;
  /** True for the "Others" line, which stands for more than one model. */
  others: boolean;
}

/**
 * The `limit` largest models by one metric, plus everything else as one row.
 *
 * Zero-valued models are kept rather than filtered: a model that ran turns
 * but cost nothing measurable is a fact about the bill, and hiding it makes
 * the rows disagree with the other cards. "Others" appears only when there
 * is something left over, so a workspace on two models does not get a line
 * that is permanently $0.00.
 */
export function breakdown(
  models: readonly ModelUsage[],
  metric: (usage: ModelUsage) => number,
  limit = 3,
): BreakdownRow[] {
  const ranked = [...models].sort((a, b) => metric(b) - metric(a));
  const top = ranked.slice(0, limit).map((usage) => ({
    model: usage.model,
    value: metric(usage),
    others: false,
  }));

  const rest = ranked.slice(limit);
  if (rest.length === 0) return top;

  return [
    ...top,
    { model: null, value: rest.reduce((sum, usage) => sum + metric(usage), 0), others: true },
  ];
}

/**
 * A model id as a person would read it.
 *
 * The catalogue is the source when it has the id -- it carries the provider's
 * own display name. Without it the id is cut back to its last segment and
 * left otherwise alone: `anthropic/claude-sonnet-4.5` is more useful as
 * "claude-sonnet-4.5" than as a slug guessed into title case, and a model
 * retired from the catalogue still has turns in the log.
 */
export function modelLabel(
  model: string | null,
  names: ReadonlyMap<string, string>,
  others = false,
): string {
  if (others) return "Others";
  if (!model) return "Unknown";
  return names.get(model) ?? model.split("/").pop() ?? model;
}
