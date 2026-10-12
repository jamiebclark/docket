// Pure, the whole of the clock: no database, no server, no `Date.now()`.

import { Temporal } from "@js-temporal/polyfill";
import { isValidTimeZone } from "../validation/timezone";

export const CADENCES = ["off", "immediate", "digest"] as const;
export type Cadence = (typeof CADENCES)[number];

export interface ScheduleSettings {
  cadence: Cadence;
  digestHour: number;
  timeZone: string;
  quietStartHour: number | null;
  quietEndHour: number | null;
}

/** The person's zone, or the deterministic default (N48, FR-008). An unrecognised stored zone -> "UTC". */
export function resolveZone(stored: string | null, projectZones: readonly string[]): string {
  if (stored) return isValidTimeZone(stored) ? stored : "UTC";
  if (projectZones.length === 0) return "UTC";
  const first = projectZones[0]!;
  return projectZones.every((z) => z === first) ? first : "UTC";
}

function toZoned(instant: Date, zone: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(instant.getTime()).toZonedDateTimeISO(zone);
}

/** The resolved instant of `hour` on `date` in `zone` (N50, FR-019). */
export function atLocalHour(date: Temporal.PlainDate, hour: number, zone: string): Date {
  const zdt = date
    .toPlainDateTime(Temporal.PlainTime.from({ hour }))
    .toZonedDateTime(zone, { disambiguation: "compatible" });
  return new Date(zdt.epochMilliseconds);
}

/** True when `instant` falls inside the window in the person's zone. Always false with no window (E14). */
export function insideQuietHours(s: ScheduleSettings, instant: Date): boolean {
  if (s.quietStartHour === null || s.quietEndHour === null) return false;
  const zdt = toZoned(instant, s.timeZone);
  const hour = zdt.hour;
  const { quietStartHour: start, quietEndHour: end } = s;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

/** The absolute instant the current quiet window ends, resolved on that local day (N49, N50). */
export function quietWindowEnd(s: ScheduleSettings, instant: Date): Date {
  if (s.quietStartHour === null || s.quietEndHour === null) return instant;
  const zdt = toZoned(instant, s.timeZone);
  const today = zdt.toPlainDate();
  const wraps = s.quietStartHour > s.quietEndHour;
  const endsToday = !wraps || zdt.hour < s.quietEndHour;
  const endDate = endsToday ? today : today.add({ days: 1 });
  return atLocalHour(endDate, s.quietEndHour, s.timeZone);
}

export function isSameLocalDay(a: Date, b: Date, zone: string): boolean {
  return Temporal.PlainDate.compare(toZoned(a, zone).toPlainDate(), toZoned(b, zone).toPlainDate()) === 0;
}

/** A digest claimed after its own local day has passed is skipped, not sent stale (N53, FR-017). */
export function isStaleDigest(s: ScheduleSettings, dueAt: Date, now: Date): boolean {
  if (s.cadence !== "digest") return false;
  return !isSameLocalDay(dueAt, now, s.timeZone);
}

/**
 * The one answer to "when next?" (E12, FR-016 to FR-020). Never returns a past instant for a digest
 * that has already been sent today, and never skips a local day's problems.
 */
export function nextDue(s: ScheduleSettings, lastSentAt: Date | null, now: Date): Date {
  if (s.cadence === "off") throw new Error("nextDue: cadence is off");
  if (s.cadence === "immediate") {
    return insideQuietHours(s, now) ? quietWindowEnd(s, now) : now;
  }
  const zdt = toZoned(now, s.timeZone);
  const today = zdt.toPlainDate();
  const todayAtHour = atLocalHour(today, s.digestHour, s.timeZone);
  if (todayAtHour.getTime() > now.getTime()) return todayAtHour;
  if (!lastSentAt || !isSameLocalDay(lastSentAt, now, s.timeZone)) return now;
  return atLocalHour(today.add({ days: 1 }), s.digestHour, s.timeZone);
}
