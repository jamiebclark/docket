import { formatFull, formatLocal } from "@/lib/time/format";

export { formatLocal };

/**
 * A time in the project's zone. The zone is always shown; `title` carries the full date for hover, and
 * `dateTime` the exact instant for machines.
 */
export function LocalTime({ value, timeZone }: { value: Date | string; timeZone: string }) {
  const date = new Date(value);
  const full = formatFull(date, timeZone);
  return (
    <time dateTime={date.toISOString()} title={full}>
      {formatLocal(date, timeZone)}
    </time>
  );
}
