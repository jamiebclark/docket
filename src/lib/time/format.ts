/**
 * The app's one date format: an instant rendered in a project's zone, e.g. "Mon, Oct 5, 9:00 AM EDT".
 *
 * Every date a person sees goes through this — tables, dialogs, announcements, provider notes — so the
 * shape never drifts between screens (design system §4). `tests/lint/date-format.test.ts` fails the
 * build on a hand-rolled formatter. In JSX prefer `LocalTime`, which wraps this in a `<time>` with the
 * exact instant and a full-date tooltip.
 */
export function formatLocal(value: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

/** The long form behind a `LocalTime` tooltip, e.g. "Monday, October 5, 2026 at 9:00:00 AM EDT". */
export function formatFull(value: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full", timeStyle: "long" }).format(new Date(value));
}

/**
 * Just the clock time, e.g. "9:05 AM EDT", for a row that already sits under a heading naming its
 * day (design-system.md §4, §19).
 *
 * The second instant format in the app, and deliberately narrow: it is only correct where the date
 * is stated nearby, because on its own it cannot say which day it means. Everywhere else is
 * `formatLocal`. The zone is kept — a time without one is ambiguous wherever the reader is.
 */
export function formatTimeOnly(value: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(
    new Date(value),
  );
}

export class InvalidLocalDateError extends Error {
  constructor(value: string) {
    super(`formatLocalDate expects "YYYY-MM-DD", got ${JSON.stringify(value)}`);
    this.name = "InvalidLocalDateError";
  }
}

/** A calendar date, e.g. "Mar 14, 2027" (B30). `value` must be a "YYYY-MM-DD" string — no zone involved. */
export function formatLocalDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new InvalidLocalDateError(value);
  const [, year, month, day] = match;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(
    new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))),
  );
}

/** A month and day with no year, e.g. "Mar 14" (B30). `value` is "MM-DD" or "YYYY-MM-DD". */
export function formatMonthDay(value: string): string {
  const parts = value.split("-");
  const month = Number(parts.length === 3 ? parts[1] : parts[0]);
  const day = Number(parts.length === 3 ? parts[2] : parts[1]);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
    new Date(Date.UTC(2001, month - 1, day)),
  );
}

/**
 * The calendar day an instant falls on in a given zone, as "YYYY-MM-DD".
 *
 * A grouping key, not a display string — but it lives here rather than in the component that needed
 * it, because `tests/lint/date-format.test.ts` makes this module the only place `Intl.DateTimeFormat`
 * is constructed, and `dayHeading` below does display its result.
 */
export function dayKeyInZone(value: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

/**
 * The heading over a day's worth of items in a list: "Today", "Yesterday", or "Mon, Oct 19"
 * (design-system.md §19). `key` is a `dayKeyInZone` value; `now` is the instant "today" is measured
 * against, passed in so the caller owns the clock.
 *
 * Deliberately not a relative time like "3 hours ago": §4 keeps one format for an instant, and the
 * grouping is what carries "recently or a while ago" in a list.
 */
export function dayHeading(key: string, timeZone: string, now: Date): string {
  if (key === dayKeyInZone(now, timeZone)) return "Today";
  if (key === dayKeyInZone(new Date(now.getTime() - 86_400_000), timeZone)) return "Yesterday";
  // The same weekday/month/day parts `formatLocal` uses, with no time and no zone shift: `key` is
  // already the local day, so it is read back as UTC to avoid moving it.
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    new Date(`${key}T00:00:00Z`),
  );
}
