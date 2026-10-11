// The three fixed snooze choices, resolved once to an absolute instant (N17). Pure: no database, no server.

import { Temporal } from "@js-temporal/polyfill";

/** The three fixed choices (N17). The order is the order they are offered in. */
export const SNOOZE_CHOICES = ["hour", "tomorrow", "next_week"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];

/** The control labels. */
export const SNOOZE_LABEL: Record<SnoozeChoice, string> = {
  hour: "1 hour",
  tomorrow: "Tomorrow morning",
  next_week: "Next week",
};

/** 09:00 — the start of a working day (the spec's wording choice, named once). */
export const MORNING_HOUR = 9;

export function parseSnoozeChoice(value: unknown): SnoozeChoice | null {
  return typeof value === "string" && (SNOOZE_CHOICES as readonly string[]).includes(value) ? (value as SnoozeChoice) : null;
}

function atMorning(date: Temporal.PlainDate, timeZone: string): Temporal.Instant {
  return date
    .toPlainDateTime(Temporal.PlainTime.from({ hour: MORNING_HOUR }))
    .toZonedDateTime(timeZone, { disambiguation: "compatible" })
    .toInstant();
}

/** The next Monday strictly after `date` — 1 to 7 days away, never `date` itself. */
function nextMonday(date: Temporal.PlainDate): Temporal.PlainDate {
  return date.add({ days: 8 - date.dayOfWeek });
}

/**
 * The absolute instant the event comes back, resolved once, now (N17, FR-009).
 * - "hour": exactly one hour after `now`.
 * - "tomorrow": MORNING_HOUR on the next calendar day in `timeZone`.
 * - "next_week": MORNING_HOUR on the next Monday strictly after today in `timeZone`.
 * The two wall-clock choices go through `toZonedDateTime(timeZone, { disambiguation: "compatible" })`:
 * a wall time that does not exist (spring forward) moves to just after the gap; an ambiguous one
 * (autumn back) takes the earlier offset — the rule Docket already uses for posting slots (research D2).
 * Always strictly after `now`; throws if it ever is not.
 */
export function resolveSnooze(choice: SnoozeChoice, now: Date, timeZone: string): Date {
  const nowInstant = Temporal.Instant.fromEpochMilliseconds(now.getTime());
  let instant: Temporal.Instant;
  if (choice === "hour") {
    instant = nowInstant.add({ hours: 1 });
  } else {
    const today = nowInstant.toZonedDateTimeISO(timeZone).toPlainDate();
    instant = atMorning(choice === "tomorrow" ? today.add({ days: 1 }) : nextMonday(today), timeZone);
  }
  if (Temporal.Instant.compare(instant, nowInstant) <= 0) {
    throw new Error("resolveSnooze: resolved instant is not strictly after now");
  }
  return new Date(instant.epochMilliseconds);
}
