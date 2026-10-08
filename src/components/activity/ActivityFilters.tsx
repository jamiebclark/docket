import Link from "next/link";
import { buttonStyles } from "@/components/ui/Button";
import { ChoiceField } from "@/components/ui/ChoiceField";
import { checkStyles, hintStyles, labelStyles } from "@/components/ui/controls";
import { Field } from "@/components/ui/Field";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { ACTIVITY_OUTCOMES, OUTCOME_LABEL, type ActivityPreset } from "@/lib/activity/outcomes";
import { filterToSearchParams, type ActivityFilter, type ActivityRange } from "@/server/services/activity/filters";

const RANGES: { range: ActivityRange; label: string }[] = [
  { range: "today", label: "Today" },
  { range: "7d", label: "7 days" },
  { range: "30d", label: "30 days" },
];

/**
 * The activity filters as a GET form, so the URL is the shareable state. Every link here is built from the
 * current filter and carries no `before`/`after`, so changing a filter always starts from the newest page.
 */
export function ActivityFilters({
  basePath,
  filter,
  platforms,
  accounts,
  timeZone,
  projects,
}: {
  basePath: string;
  filter: ActivityFilter;
  platforms: { key: string; name: string }[];
  accounts: { id: string; name: string }[];
  /** Null on the all-projects screen, where each project has its own zone. */
  timeZone: string | null;
  /** All-projects only: the caller's projects, as a checkbox list. */
  projects?: { slug: string; name: string }[];
}) {
  const dayHint = timeZone ? `Days in ${timeZone}` : "Days in each project's own time zone";
  const href = (change: (p: URLSearchParams) => void) => {
    const p = filterToSearchParams(filter);
    change(p);
    const qs = p.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const presetTab = (label: string, preset: ActivityPreset | null) => ({
    label,
    active: preset === null ? filter.outcomes === null : filter.preset === preset,
    href: href((p) => (preset ? p.set("outcome", preset) : p.delete("outcome"))),
  });
  const filtered = Boolean(filter.outcomes || filter.platform || filter.accountId || filter.range || filter.from || filter.to || filter.projectSlugs);

  return (
    <form method="get" action={basePath} className="mb-6 flex flex-col gap-4" aria-label="Filter activity">
      <FilterTabs label="Outcome preset" tabs={[presetTab("All", null), presetTab("Successes", "successes"), presetTab("Problems", "problems")]} />

      <fieldset className="flex flex-col gap-2">
        <legend className={labelStyles}>Outcome</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {ACTIVITY_OUTCOMES.map((o) => (
            <label key={o} className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" name="outcome" value={o} defaultChecked={filter.outcomes?.has(o) ?? false} className={checkStyles} />
              {OUTCOME_LABEL[o]}
            </label>
          ))}
        </div>
      </fieldset>

      {projects ? (
        <fieldset className="flex flex-col gap-2">
          <legend className={labelStyles}>Projects</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {projects.map((p) => (
              <label key={p.slug} className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" name="project" value={p.slug} defaultChecked={filter.projectSlugs?.includes(p.slug) ?? false} className={checkStyles} />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <ChoiceField
          id="activity-platform"
          name="platform"
          label="Platform"
          autoSubmit
          defaultValue={filter.platform ?? ""}
          options={[{ value: "", label: "All platforms" }, ...platforms.map((p) => ({ value: p.key, label: p.name }))]}
        />
        {projects ? null : <ChoiceField
          id="activity-account"
          name="account"
          label="Account"
          autoSubmit
          defaultValue={filter.accountId ?? ""}
          options={[{ value: "", label: "All accounts" }, ...accounts.map((a) => ({ value: a.id, label: a.name }))]}
        />}
      </div>

      {filter.range ? <input type="hidden" name="range" value={filter.range} /> : null}
      <div className="flex flex-wrap items-end gap-4">
        <Field id="activity-from" name="from" type="date" label="From" defaultValue={filter.from?.toString() ?? ""} hint={dayHint} />
        <Field id="activity-to" name="to" type="date" label="To" defaultValue={filter.to?.toString() ?? ""} hint={dayHint} />
        <button type="submit" className={buttonStyles({ variant: "secondary" })}>
          Apply
        </button>
      </div>

      <nav aria-label="Date range" className="flex flex-wrap items-center gap-2">
        <span className={hintStyles}>Quick range:</span>
        {RANGES.map((r) => (
          <Link
            key={r.range}
            href={href((p) => {
              p.delete("from");
              p.delete("to");
              p.set("range", r.range);
            })}
            aria-current={filter.range === r.range ? "page" : undefined}
            className={buttonStyles({ variant: filter.range === r.range ? "primary" : "secondary", size: "sm" })}
          >
            {r.label}
          </Link>
        ))}
        {filtered ? (
          <Link href={basePath} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
            Clear filters
          </Link>
        ) : null}
      </nav>
      <noscript>
        <button type="submit" className={buttonStyles({ variant: "secondary" })}>
          Apply filters
        </button>
      </noscript>
    </form>
  );
}
