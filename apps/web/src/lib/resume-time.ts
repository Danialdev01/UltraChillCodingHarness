/** A limit's reset is the CLI's word to the minute: a little after it, the plan surely has room. */
const RESET_MARGIN_MS = 60_000;

/** What a limit that named no reset is assumed to take: a plan's session window. */
const UNKNOWN_WAIT_MS = 5 * 60 * 60_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** A moment as a `datetime-local` input holds it: the reader's own clock, to the minute. */
export function toLocalInput(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The input's value as ISO, or null when it is empty or not a time. */
export function fromLocalInput(value: string): string | null {
  const at = new Date(value).getTime();
  return value && Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** The time a session is offered to carry on at: just past the reset, rounded up to the minute. */
export function suggestedResume(resetsAt: string | undefined, now = Date.now()): number {
  const reset = resetsAt ? Date.parse(resetsAt) : NaN;
  const at = reset > now ? reset + RESET_MARGIN_MS : now + UNKNOWN_WAIT_MS;
  return Math.ceil(at / 60_000) * 60_000;
}

/** "10:07", or "Wed, Nov 25, 10:07" on another day. */
export function formatResume(at: string, now = Date.now()): string {
  const d = new Date(at);
  const today = d.toDateString() === new Date(now).toDateString();
  return d.toLocaleString(undefined, {
    ...(today ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
