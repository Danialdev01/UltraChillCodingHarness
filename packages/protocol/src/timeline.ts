/** What the server and the web app agree on about timeline tasks. */

export const TIMELINE_TITLE_MAX = 200;

/** The bar colours, by the note colour names so both features share one palette. */
export const TIMELINE_COLOURS = [
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const;

export type TimelineColour = (typeof TIMELINE_COLOURS)[number];

/** A calendar date as the API carries it: `YYYY-MM-DD`, no time, no zone. */
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A task as the API carries it: dates as `YYYY-MM-DD`, instants as ISO strings. */
export interface TimelineTaskRecord {
  id: string;
  title: string;
  startsOn: string;
  /** Inclusive: a one-day task starts and ends on the same day. */
  endsOn: string;
  /** 0..100 */
  progress: number;
  colour: TimelineColour;
  position: number;
  dependsOnId: string | null;
  createdAt: string;
  updatedAt: string;
}
