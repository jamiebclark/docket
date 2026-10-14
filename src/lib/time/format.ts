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
