import { formatFull, formatLocal, formatTimeOnly } from "@/lib/time/format";

export { formatLocal };

/**
 * A time in the project's zone. The zone is always shown; `title` carries the full date for hover, and
 * `dateTime` the exact instant for machines.
 */
export function LocalTime({
  value,
  timeZone,
  format = "full",
}: {
  value: Date | string;
  timeZone: string;
  /**
   * `time` drops the date for a row that already sits under a heading naming its day (§4, §19).
   * The tooltip still carries the whole date, so nothing is lost to a reader who checks.
   */
  format?: "full" | "time";
}) {
  const date = new Date(value);
  const full = formatFull(date, timeZone);
  return (
    <time dateTime={date.toISOString()} title={full}>
      {format === "time" ? formatTimeOnly(date, timeZone) : formatLocal(date, timeZone)}
    </time>
  );
}
