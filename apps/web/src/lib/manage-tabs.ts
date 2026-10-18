/** The tabs on a project's manage page, in the order they are shown. */
export const MANAGE_TABS = [
  { id: "git", label: "Git" },
  { id: "activity", label: "Activity" },
  { id: "preferences", label: "Preferences" },
] as const;

export type ManageTab = (typeof MANAGE_TABS)[number]["id"];

/** The tab a `?tab=` value names, or the first one for anything else. */
export function manageTabOf(value: string | string[] | undefined): ManageTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return MANAGE_TABS.find((t) => t.id === raw)?.id ?? "git";
}
