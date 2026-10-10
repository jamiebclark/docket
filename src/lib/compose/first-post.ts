/** YYYY-MM-DD of an instant in an IANA zone. Instant to date is unambiguous, so formatToParts is enough. */
export function zonedDate(instant: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    typeof instant === "string" ? new Date(instant) : instant,
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function firstPostCalendarHref(input: {
  slug: string;
  kind: "queue" | "schedule" | "now";
  rows: readonly { ok: boolean; scheduledAt?: string }[];
  timeZone: string;
}): string {
  const base = `/p/${encodeURIComponent(input.slug)}/calendar`;
  if (input.kind === "now") return base;
  const times = input.rows
    .filter((r) => r.ok && r.scheduledAt)
    .map((r) => new Date(r.scheduledAt!))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  const earliest = times[0];
  if (!earliest) return base;
  return `${base}?view=month&date=${zonedDate(earliest, input.timeZone)}`;
}
