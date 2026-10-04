import { Temporal } from "@js-temporal/polyfill";

export interface SlotLike {
  id: string;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** `HH:MM` (or `HH:MM:SS`) wall-clock time in the project's zone. */
  localTime: string;
  paused: boolean;
}

export interface Occurrence {
  instant: Temporal.Instant;
  slotId: string;
  local: Temporal.ZonedDateTime;
}

/** A wall-clock time that does not exist (spring forward) moves to just after the gap; an ambiguous one takes the earlier offset (research D2). */
export function resolveOccurrence(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZone: string,
): Temporal.Instant {
  return date
    .toPlainDateTime(time)
    .toZonedDateTime(timeZone, { disambiguation: "compatible" })
    .toInstant();
}

/** Active slots' occurrences with `from < instant ≤ to`, in time order, one per instant. */
export function occurrencesBetween(
  slots: readonly SlotLike[],
  timeZone: string,
  from: Temporal.Instant,
  to: Temporal.Instant,
): Occurrence[] {
  const active = slots.filter((s) => !s.paused);
  if (active.length === 0 || Temporal.Instant.compare(to, from) <= 0) return [];
  // One day of slack each side: a local date's occurrence can fall outside [from, to] only by the zone offset.
  let day = from.toZonedDateTimeISO(timeZone).toPlainDate().subtract({ days: 1 });
  const last = to.toZonedDateTimeISO(timeZone).toPlainDate().add({ days: 1 });
  const byInstant = new Map<string, Occurrence>();
  for (; Temporal.PlainDate.compare(day, last) <= 0; day = day.add({ days: 1 })) {
    for (const slot of active) {
      if (slot.weekday !== day.dayOfWeek) continue;
      const instant = resolveOccurrence(day, Temporal.PlainTime.from(slot.localTime), timeZone);
      if (Temporal.Instant.compare(instant, from) <= 0 || Temporal.Instant.compare(instant, to) > 0) continue;
      const key = instant.toString();
      const existing = byInstant.get(key);
      // Two slots at the same instant make one occurrence; the lowest slot id names it, deterministically.
      if (!existing || slot.id < existing.slotId) {
        byInstant.set(key, { instant, slotId: slot.id, local: instant.toZonedDateTimeISO(timeZone) });
      }
    }
  }
  return [...byInstant.values()].sort((a, b) => Temporal.Instant.compare(a.instant, b.instant));
}

/** A project-zone wall-clock `YYYY-MM-DDTHH:MM` to an instant, by Temporal `compatible`: a gap moves later, an overlap takes the earlier offset. */
export function resolveLocalDateTime(timeZone: string, local: string): Temporal.Instant {
  return Temporal.PlainDateTime.from(local).toZonedDateTime(timeZone, { disambiguation: "compatible" }).toInstant();
}
