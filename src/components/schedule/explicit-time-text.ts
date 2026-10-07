import { formatLocal } from "@/components/ui/LocalTime";

export function explicitTimeText(p: { kind: "exact" | "gap" | "overlap"; instant: string; resolvedLocal: string }, timeZone: string): string {
  const at = formatLocal(p.instant, timeZone);
  if (p.kind === "gap") return `That time does not exist on that day (clocks skip forward); it will post at ${p.resolvedLocal.slice(11)} instead. ${at}`;
  if (p.kind === "overlap") return `That time happens twice on that day (clocks go back); the earlier one is used. ${at}`;
  return at;
}
