import Link from "next/link";
import { hintStyles } from "@/components/ui/controls";
import type { ActivityPreset } from "@/lib/activity/outcomes";
import type { ActivitySummary as Summary } from "@/server/services/activity";
import { filterToSearchParams, type ActivityFilter } from "@/server/services/activity/filters";

/** "{label}: N successes · M problems"; each count links to its preset with the other filters kept. */
export function ActivitySummary({ summary, filter, basePath }: { summary: Summary; filter: ActivityFilter; basePath: string }) {
  const href = (preset: ActivityPreset) => {
    const p = filterToSearchParams(filter);
    p.set("outcome", preset);
    return `${basePath}?${p.toString()}`;
  };
  return (
    <p aria-live="polite" className="text-sm">
      <span className="font-medium">{summary.label}:</span>{" "}
      <Link href={href("successes")} prefetch={false} className="underline">
        {summary.successes} successes
      </Link>
      {" · "}
      <Link href={href("problems")} prefetch={false} className="underline">
        {summary.problems} problems
      </Link>
      {filter.outcomes ? <span className={hintStyles}> (counts ignore the outcome filter)</span> : null}
    </p>
  );
}
