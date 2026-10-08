import { relativeTimeText } from "@/lib/time/relative";
import { formatLocal } from "./LocalTime";

/** A relative time ("12 min ago") whose absolute time and zone are the tooltip and screen-reader text. Pure: `now` is a prop. */
export function RelativeTime({ value, timeZone, now }: { value: Date | string; timeZone: string; now: Date }) {
  const date = new Date(value);
  const absolute = `${formatLocal(date, timeZone)} (${timeZone})`;
  return (
    <time dateTime={date.toISOString()} title={absolute}>
      {relativeTimeText(date, now)}
      <span className="sr-only">, {absolute}</span>
    </time>
  );
}
