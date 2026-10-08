import { Temporal } from "@js-temporal/polyfill";
import { ACTIVITY_OUTCOMES, PRESETS, isActivityOutcome, type ActivityOutcome, type ActivityPreset } from "../../../lib/activity/outcomes";

// One parser for the screens (lenient: drop what is unknown) and the API (strict: report it). Research P12.

export type ActivityRange = "today" | "7d" | "30d";

export interface ActivityFilter {
  outcomes: Set<ActivityOutcome> | null;
  /** Set when the outcome parameter was exactly one preset, so links and chips can name it. */
  preset: ActivityPreset | null;
  platform: string | null;
  accountId: string | null;
  from: Temporal.PlainDate | null;
  to: Temporal.PlainDate | null;
  range: ActivityRange | null;
  projectSlugs: string[] | null;
  /** `from` is after `to`: no rows, an inline message. */
  invalidRange: boolean;
}

export interface FilterIssue {
  field: "outcome" | "platform" | "account" | "from" | "to" | "range";
  message: string;
}

export type RawParams = Record<string, string | string[] | undefined>;

export interface ParseOptions {
  mode: "lenient" | "strict";
  /** All-projects only: read `project` slugs. */
  allowProjects?: boolean;
  /** Registered provider keys. When given, an unknown `platform` is dropped (lenient) or reported (strict). */
  knownPlatforms?: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RANGES: readonly ActivityRange[] = ["today", "7d", "30d"];

function values(raw: string | string[] | undefined): string[] {
  const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return list.flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
}

function first(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === undefined || v.trim() === "" ? null : v.trim();
}

function parseDay(value: string): Temporal.PlainDate | null {
  if (!DAY.test(value)) return null;
  try {
    return Temporal.PlainDate.from(value, { overflow: "reject" });
  } catch {
    return null;
  }
}

export function parseActivityFilter(raw: RawParams, opts: ParseOptions): { filter: ActivityFilter; issues: FilterIssue[] } {
  const strict = opts.mode === "strict";
  const issues: FilterIssue[] = [];
  const report = (field: FilterIssue["field"], message: string) => {
    if (strict) issues.push({ field, message });
  };

  const tokens = values(raw.outcome);
  const outcomes = new Set<ActivityOutcome>();
  let presetTokens = 0;
  let preset: ActivityPreset | null = null;
  for (const t of tokens) {
    if (t === "successes" || t === "problems") {
      presetTokens++;
      preset = t;
      for (const o of PRESETS[t]) outcomes.add(o);
    } else if (isActivityOutcome(t)) outcomes.add(t);
    else report("outcome", `"${t}" is not an outcome. Use ${[...ACTIVITY_OUTCOMES, "successes", "problems"].join(", ")}.`);
  }
  const onlyPreset = presetTokens === 1 && tokens.length === 1;

  let platform = first(raw.platform);
  if (platform && opts.knownPlatforms && !opts.knownPlatforms.includes(platform)) {
    report("platform", `"${platform}" is not a known platform.`);
    platform = null;
  }

  let accountId = first(raw.account);
  if (accountId && !UUID.test(accountId)) {
    report("account", "The account must be an id.");
    accountId = null;
  }

  let range: ActivityRange | null = null;
  const rawRange = first(raw.range);
  if (rawRange) {
    if ((RANGES as readonly string[]).includes(rawRange)) range = rawRange as ActivityRange;
    else report("range", `"${rawRange}" is not a range. Use today, 7d or 30d.`);
  }

  let from: Temporal.PlainDate | null = null;
  let to: Temporal.PlainDate | null = null;
  const rawFrom = first(raw.from);
  const rawTo = first(raw.to);
  if (rawFrom) {
    from = parseDay(rawFrom);
    if (!from) report("from", "Use a date like 2026-10-01.");
  }
  if (rawTo) {
    to = parseDay(rawTo);
    if (!to) report("to", "Use a date like 2026-10-01.");
  }
  // A range replaces the dates in the API. On the screens the filter form carries the active quick range as a
  // hidden input, so dates the person typed replace it instead.
  if (range && !strict && (rawFrom || rawTo)) range = null;
  if (range) {
    from = null;
    to = null;
  }
  const invalidRange = Boolean(from && to && Temporal.PlainDate.compare(from, to) > 0);
  if (invalidRange) report("from", "The start date is after the end date.");

  const slugs = opts.allowProjects ? values(raw.project) : [];

  return {
    filter: {
      outcomes: outcomes.size > 0 ? outcomes : null,
      preset: onlyPreset ? preset : null,
      platform,
      accountId,
      from,
      to,
      range,
      projectSlugs: opts.allowProjects && slugs.length > 0 ? [...new Set(slugs)] : null,
      invalidRange,
    },
    issues,
  };
}

/** The half-open instant window `[from, to)` of the filter's days in one project's zone; each bound `null` when open. */
export function windowFor(filter: ActivityFilter, timeZone: string, now: Date): { from: Date | null; to: Date | null } {
  let from = filter.from;
  let to = filter.to;
  if (filter.range) {
    const today = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone).toPlainDate();
    to = today;
    from = filter.range === "today" ? today : today.subtract({ days: filter.range === "7d" ? 6 : 29 });
  }
  const start = (d: Temporal.PlainDate) => new Date(d.toZonedDateTime({ timeZone }).epochMilliseconds);
  return { from: from ? start(from) : null, to: to ? start(to.add({ days: 1 })) : null };
}

export function summaryLabel(filter: ActivityFilter): string {
  if (filter.range === "today") return "Today";
  if (filter.range === "7d") return "Last 7 days";
  if (filter.range === "30d") return "Last 30 days";
  if (filter.from && filter.to) return `${filter.from.toString()} – ${filter.to.toString()}`;
  if (filter.from) return `Since ${filter.from.toString()}`;
  if (filter.to) return `Until ${filter.to.toString()}`;
  return "All time";
}

/** The canonical query string for a filter; every link on the screens is built from it. */
export function filterToSearchParams(filter: ActivityFilter): URLSearchParams {
  const p = new URLSearchParams();
  if (filter.preset) p.set("outcome", filter.preset);
  else if (filter.outcomes) p.set("outcome", ACTIVITY_OUTCOMES.filter((o) => filter.outcomes!.has(o)).join(","));
  if (filter.platform) p.set("platform", filter.platform);
  if (filter.accountId) p.set("account", filter.accountId);
  if (filter.range) p.set("range", filter.range);
  else {
    if (filter.from) p.set("from", filter.from.toString());
    if (filter.to) p.set("to", filter.to.toString());
  }
  for (const slug of filter.projectSlugs ?? []) p.append("project", slug);
  return p;
}
