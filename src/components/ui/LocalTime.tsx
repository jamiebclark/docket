/** Formats an instant in the given IANA zone, e.g. "Mon, Oct 5, 9:00 AM EDT". */
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

/**
 * A time in the project's zone. The zone is always shown; `title` carries the full date for hover, and
 * `dateTime` the exact instant for machines.
 */
export function LocalTime({ value, timeZone }: { value: Date | string; timeZone: string }) {
  const date = new Date(value);
  const full = new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "full", timeStyle: "long" }).format(date);
  return (
    <time dateTime={date.toISOString()} title={full}>
      {formatLocal(date, timeZone)}
    </time>
  );
}
