/**
 * What `@reviewer` and `@council` use in a project when a message names
 * nothing (plan4 §4.4): the reviewer's model, the council's size and its
 * rounds. Any member reads it; a workspace admin changes it.
 */
export interface DeliberationSettingsState {
  /** `auto`, `same`, or a model id. */
  reviewerModel: string;
  councilSize: number;
  councilRounds: number;
  canChange: boolean;
}

export type DeliberationPatch = Partial<Omit<DeliberationSettingsState, "canChange">>;

async function call(hash: string, fallback: string, init?: RequestInit): Promise<DeliberationSettingsState> {
  const response = await fetch(`/api/projects/${hash}/deliberation`, { credentials: "include", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? fallback);
  }
  return (await response.json()) as DeliberationSettingsState;
}

export const fetchDeliberationSettings = (hash: string) => call(hash, "Could not load the Reviewer and Council settings.");

export const setDeliberationSettings = (hash: string, patch: DeliberationPatch) =>
  call(hash, "Could not save the Reviewer and Council settings.", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
