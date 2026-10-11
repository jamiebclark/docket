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
