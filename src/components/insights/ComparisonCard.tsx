// components/insights/ComparisonCard: one comparison's counts, cautions, suppressed count and
// exclusions (contracts/comparisons.md §1-§2, contracts/charts.md §3). No ranking, superlative or
// ordering wording below the floor (FR-033) — this card states what was observed and how many posts,
// never why.
import { GroupChart } from "@/components/insights/GroupChart";
import type { Comparison, ExclusionReason } from "@/lib/insights/compare";

const DIMENSION_LABELS: Record<Comparison["dimension"], string> = {
  slot: "By posting slot",
  day_of_week: "By day of week",
  series_kind: "By series kind",
  voice_profile: "By voice profile",
  origin: "By origin",
};

const EXCLUSION_LABELS: Record<ExclusionReason, string> = {
  no_external_id: "not yet resolved to a post Docket can read",
  no_snapshot: "never polled, or nothing reported",
  not_slot_scheduled: "not scheduled from a posting slot",
  frozen_without_reading: "stopped being read before anything was observed",
  series_unrecorded: "not from a recorded standing series",
  metric_shape_unknown: "this metric's shape is not known",
};

export function ComparisonCard({ comparison }: { comparison: Comparison }) {
  const title = `${DIMENSION_LABELS[comparison.dimension]} — ${comparison.platform} · ${comparison.label}`;

  if (comparison.refusal) {
    return (
      <div>
        <h3 className="text-sm font-semibold text-heading">{title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{comparison.refusal}</p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-heading">{title}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {comparison.conclusion === "not_enough_posts"
          ? "Not enough posts yet to rank — counts only, in no particular order."
          : "Enough posts to compare."}
      </p>

      <div className="mt-3">
        <GroupChart comparison={comparison} />
      </div>

      {comparison.suppressedGroupCount > 0 || comparison.exclusions.length > 0 ? (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
            What isn&apos;t shown
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
            {comparison.suppressedGroupCount > 0 ? (
              <li>
                {comparison.suppressedGroupCount} group{comparison.suppressedGroupCount === 1 ? "" : "s"} with too few posts to show at all.
              </li>
            ) : null}
            {comparison.exclusions.map((exclusion) => (
              <li key={exclusion.reason}>
                {exclusion.count} post{exclusion.count === 1 ? "" : "s"} excluded: {EXCLUSION_LABELS[exclusion.reason]}.
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
