import { formatLocalDate } from "@/lib/time/format";

/** A calendar date, zone-independent. No tooltip — there is no instant behind a date (B30). */
export function LocalDate({ value }: { value: string }) {
  return <time dateTime={value}>{formatLocalDate(value)}</time>;
}
