/**
 * The geometry of a Gantt chart, with no DOM in it.
 *
 * Everything here works on calendar days counted from the Unix epoch, in
 * UTC, so a date is an integer and a bar's width is a subtraction. Tasks
 * carry `YYYY-MM-DD` strings; `toDay` and `fromDay` are the only two places
 * a `Date` is ever constructed, and they use `Date.UTC` so that a string
 * parsed in a browser west of Greenwich does not land on the day before.
 *
 * The chart draws what this computes; the tests check this, not the SVG.
 */

const DAY_MS = 86_400_000;

export type Zoom = "day" | "week" | "month";

/** How wide one day is at each zoom, in CSS pixels. */
export const PX_PER_DAY: Record<Zoom, number> = { day: 40, week: 16, month: 5 };

/** The columns the chart spans: from `start` to `end`, both inclusive, in epoch days. */
export interface DayRange {
  start: number;
  end: number;
}

/** A column header: where it begins, how wide it is, and what it says. */
export interface Tick {
  x: number;
  width: number;
  label: string;
}

export interface DatedTask {
  startsOn: string;
  endsOn: string;
}

/** `YYYY-MM-DD` to the number of days since 1970-01-01. */
export function toDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** The inverse of `toDay`. */
export function fromDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** How many days a task covers: one for a task that starts and ends on the same day. */
export function durationDays(task: DatedTask): number {
  return toDay(task.endsOn) - toDay(task.startsOn) + 1;
}

/**
 * The columns to draw: from the earliest start to the latest end, with room
 * either side so the first bar is not against the edge, and always
 * including today so the marker has somewhere to be.
 */
export function computeRange(tasks: readonly DatedTask[], today: string, padDays = 7): DayRange {
  const now = toDay(today);
  let start = now - 14;
  let end = now + 14;
  if (tasks.length > 0) {
    start = Math.min(now, ...tasks.map((t) => toDay(t.startsOn)));
    end = Math.max(now, ...tasks.map((t) => toDay(t.endsOn)));
  }
  return { start: start - padDays, end: end + padDays };
}

export function rangeWidth(range: DayRange, pxPerDay: number): number {
  return (range.end - range.start + 1) * pxPerDay;
}

/** The left edge of a day's column. */
export function dayX(day: number, range: DayRange, pxPerDay: number): number {
  return (day - range.start) * pxPerDay;
}

/** Where a task's bar sits and how wide it is. */
export function barGeometry(
  task: DatedTask,
  range: DayRange,
  pxPerDay: number,
): { x: number; width: number } {
  return {
    x: dayX(toDay(task.startsOn), range, pxPerDay),
    width: durationDays(task) * pxPerDay,
  };
}

/** The centre of today's column, or null when today is off the chart. */
export function todayX(today: string, range: DayRange, pxPerDay: number): number | null {
  const day = toDay(today);
  if (day < range.start || day > range.end) return null;
  return dayX(day, range, pxPerDay) + pxPerDay / 2;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function utc(day: number): Date {
  return new Date(day * DAY_MS);
}

/**
 * The two header rows. The top row is always months; the bottom row is
 * whatever a column is at this zoom -- a day, an ISO week, or nothing more
 * than the month again, at which point only one row is worth drawing.
 */
export function headerTicks(
  range: DayRange,
  zoom: Zoom,
  pxPerDay = PX_PER_DAY[zoom],
): { major: Tick[]; minor: Tick[] } {
  const major = monthTicks(range, pxPerDay);
  const minor =
    zoom === "day" ? dayTicks(range, pxPerDay) : zoom === "week" ? weekTicks(range, pxPerDay) : [];
  return { major, minor };
}

function monthTicks(range: DayRange, pxPerDay: number): Tick[] {
  const ticks: Tick[] = [];
  let day = range.start;
  while (day <= range.end) {
    const date = utc(day);
    // The first day of the next month, in epoch days, is where this tick ends.
    const nextMonth = Math.round(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS,
    );
    const end = Math.min(nextMonth - 1, range.end);
    ticks.push({
      x: dayX(day, range, pxPerDay),
      width: (end - day + 1) * pxPerDay,
      label: `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`,
    });
    day = nextMonth;
  }
  return ticks;
}

function dayTicks(range: DayRange, pxPerDay: number): Tick[] {
  const ticks: Tick[] = [];
  for (let day = range.start; day <= range.end; day++) {
    ticks.push({
      x: dayX(day, range, pxPerDay),
      width: pxPerDay,
      label: String(utc(day).getUTCDate()),
    });
  }
  return ticks;
}

/** Monday-to-Sunday weeks, labelled by the Monday's date; a partial week at either edge is drawn as wide as it is. */
function weekTicks(range: DayRange, pxPerDay: number): Tick[] {
  const ticks: Tick[] = [];
  let day = range.start;
  while (day <= range.end) {
    // 1970-01-01 was a Thursday, so Monday is when (day + 3) % 7 === 0.
    const untilMonday = (7 - ((day + 3) % 7)) % 7;
    const end = Math.min(day + (untilMonday === 0 ? 6 : untilMonday - 1), range.end);
    const date = utc(day);
    ticks.push({
      x: dayX(day, range, pxPerDay),
      width: (end - day + 1) * pxPerDay,
      label: `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`,
    });
    day = end + 1;
  }
  return ticks;
}

/** Is this epoch day a Saturday or Sunday? */
export function isWeekend(day: number): boolean {
  const weekday = (day + 4) % 7; // 0 = Sunday, since 1970-01-01 was a Thursday
  return weekday === 0 || weekday === 6;
}

/** The columns to shade: one band per Saturday-Sunday pair, merged where they touch. */
export function weekendBands(range: DayRange, pxPerDay: number): { x: number; width: number }[] {
  const bands: { x: number; width: number }[] = [];
  for (let day = range.start; day <= range.end; day++) {
    if (!isWeekend(day)) continue;
    const last = bands.at(-1);
    const x = dayX(day, range, pxPerDay);
    if (last && last.x + last.width === x) last.width += pxPerDay;
    else bands.push({ x, width: pxPerDay });
  }
  return bands;
}

/** A bar as the arrow-drawing sees it: its right edge is `x + width`. */
export interface BarBox {
  x: number;
  width: number;
  row: number;
}

/**
 * The path of an arrow from the end of one bar to the start of another.
 *
 * Leaves the first bar's right edge, turns down (or up) halfway across the
 * gap, and comes in at the second bar's left edge. When the second bar
 * starts before the first ends, there is no gap to turn in, so the arrow
 * loops out past the first bar and back in below the row.
 */
export function dependencyPath(from: BarBox, to: Pick<BarBox, "x" | "row">, rowHeight: number): string {
  const gap = 8;
  const x1 = from.x + from.width;
  const y1 = from.row * rowHeight + rowHeight / 2;
  const x2 = to.x;
  const y2 = to.row * rowHeight + rowHeight / 2;
  if (x2 - x1 >= gap * 2) {
    const mid = x1 + (x2 - x1) / 2;
    return `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${y2} L ${x2} ${y2}`;
  }
  const out = x1 + gap;
  const yTurn = y1 + (y2 >= y1 ? rowHeight / 2 : -rowHeight / 2);
  const back = x2 - gap;
  return `M ${x1} ${y1} L ${out} ${y1} L ${out} ${yTurn} L ${back} ${yTurn} L ${back} ${y2} L ${x2} ${y2}`;
}

/** A drag distance in whole days, rounding to the nearest column. */
export function daysFromDelta(dx: number, pxPerDay: number): number {
  return Math.round(dx / pxPerDay);
}

/** The task moved along by `days`, keeping its length. */
export function shiftTask(task: DatedTask, days: number): { startsOn: string; endsOn: string } {
  return {
    startsOn: fromDay(toDay(task.startsOn) + days),
    endsOn: fromDay(toDay(task.endsOn) + days),
  };
}

/**
 * One end of the task moved by `days`, never past the other: a bar can be
 * dragged down to a single day, and no further.
 */
export function resizeTask(
  task: DatedTask,
  edge: "start" | "end",
  days: number,
): { startsOn: string; endsOn: string } {
  const start = toDay(task.startsOn);
  const end = toDay(task.endsOn);
  if (edge === "start") return { startsOn: fromDay(Math.min(start + days, end)), endsOn: task.endsOn };
  return { startsOn: task.startsOn, endsOn: fromDay(Math.max(end + days, start)) };
}

/** Today as `YYYY-MM-DD` in the reader's own calendar, not UTC's. */
export function localToday(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
