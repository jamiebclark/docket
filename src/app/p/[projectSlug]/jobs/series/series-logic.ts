// Pure helpers for the Standing series screens, kept out of components so tests can import them.
import type { BadgeTone } from "@/components/ui/Badge";
import type { StandingSeriesAccountView, StandingSeriesRunProblem, StandingSeriesView } from "@/server/services/standing-series/read";

type CadencePeriod = "day" | "week" | "month";
type Outcome = NonNullable<StandingSeriesView["lastRunOutcome"]>;

const PERIOD_UNIT: Record<CadencePeriod, string> = { day: "day", week: "week", month: "month" };

/** "3 posts a week" / "1 post a day". */
export function cadenceLabel(cadence: { count: number; period: CadencePeriod }): string {
  return `${cadence.count} ${cadence.count === 1 ? "post" : "posts"} a ${PERIOD_UNIT[cadence.period]}`;
}

/** The series-list/detail "how often" label: the cadence, or "Dated list" for a dated series. */
export function ruleLabel(cadence: { count: number; period: CadencePeriod } | null): string {
  return cadence ? cadenceLabel(cadence) : "Dated list";
}

/** "3 days before" / "On the day". */
export function leadLabel(leadDays: number): string {
  return leadDays === 0 ? "On the day" : `${leadDays} day${leadDays === 1 ? "" : "s"} before`;
}

export interface StateBadgeInfo {
  label: string;
  tone: BadgeTone;
  /** The `Sub` line explaining why, or null when running needs none. */
  sub: string | null;
}

/** The list/detail state badge: Running / Paused / Paused by Docket (ui.md §2). */
export function seriesStateInfo(series: Pick<StandingSeriesView, "enabled" | "autoPausedReason">): StateBadgeInfo {
  if (series.enabled) return { label: "Running", tone: "success", sub: null };
  if (series.autoPausedReason === "no_output") {
    return { label: "Paused by Docket", tone: "warning", sub: "No posts in its last 3 runs" };
  }
  return { label: "Paused", tone: "neutral", sub: "Paused by you" };
}

/** The "Posts to" column's `Sub` line (ui.md §2). */
export function mediaSummary(media: StandingSeriesView["media"]): string {
  if (media.source === "none") return "No image";
  if (media.source === "generate") return "Generates an image";
  return media.tag ? `Images from the library tagged "${media.tag}"` : "Images from the library";
}

const OUTCOME_INFO: Record<Outcome, { label: (requested: number, produced: number) => string; tone: BadgeTone }> = {
  produced_all: { label: (requested) => `All ${requested} produced`, tone: "success" },
  produced_some: { label: (requested, produced) => `${produced} of ${requested} produced`, tone: "warning" },
  produced_none: { label: () => "Nothing produced", tone: "danger" },
  incomplete: { label: () => "Closed unfinished", tone: "neutral" },
};

/** The run-history Outcome badge (ui.md §3). */
export function outcomeInfo(outcome: Outcome, requestedCount: number, produced: number): { label: string; tone: BadgeTone } {
  const info = OUTCOME_INFO[outcome];
  return { label: info.label(requestedCount, produced), tone: info.tone };
}

/** A short word for the list's "Last run" `Sub` line, which has no per-run counts to hand. */
const OUTCOME_WORD: Record<Outcome, string> = {
  produced_all: "all produced",
  produced_some: "some produced",
  produced_none: "nothing produced",
  incomplete: "closed unfinished",
};
export const outcomeWord = (outcome: Outcome): string => OUTCOME_WORD[outcome];

const SKIP_REASON_SENTENCE: Record<NonNullable<StandingSeriesRunProblem["skipReason"]>, string> = {
  pool_exhausted: "No unused images left in the pool",
  image_generation_not_configured: "Image generation is not configured",
  image_generation_failed: "Image generation failed",
  media_unusable: "The image Docket chose could not be used",
  media_storage_not_configured: "Media storage is not configured",
  series_not_runnable: "This period could not run",
};

const BLOCK_REASON_SENTENCE = {
  voice_profile_missing: "This series' voice profile is archived, so it could not run",
  no_usable_target: "None of its accounts are in this project any more",
} as const;

type BlockedReason = keyof typeof BLOCK_REASON_SENTENCE;

/** One Problems line (ui.md §3): a skip (naming the account), a failure, or the run's block reason. */
export function problemLine(problem: StandingSeriesRunProblem, blockedReason: BlockedReason | null): string {
  if (problem.failureMessage) return problem.failureMessage;
  if (problem.skipReason) {
    const sentence = SKIP_REASON_SENTENCE[problem.skipReason];
    return problem.account ? `${sentence} — ${problem.account.providerName} needs one` : sentence;
  }
  if (blockedReason) return BLOCK_REASON_SENTENCE[blockedReason];
  return "";
}

/** "Dropped 1 account that is no longer in this project." */
export function droppedAccountsLine(droppedAccountIds: readonly string[]): string | null {
  if (droppedAccountIds.length === 0) return null;
  const n = droppedAccountIds.length;
  return `Dropped ${n} account${n === 1 ? "" : "s"} that ${n === 1 ? "is" : "are"} no longer in this project.`;
}

/** "Week of"/day/month label prefix for a cadence run's period, paired with a `LocalTime` of `periodStartAt`. */
export function periodLabel(period: CadencePeriod): string {
  return period === "week" ? "Week of" : period === "month" ? "Month of" : "Day of";
}

export const accountNames = (accounts: readonly StandingSeriesAccountView[]): string => accounts.map((a) => a.displayName).join(", ");

export const FR064_EXPLANATION =
  "A post Docket knows would be refused when it publishes — one missing an image an account requires, say — waits in Review even when this series is set to approve automatically. That is deliberate: nobody is watching a standing series.";

export const STANDING_SERIES_AUTHORISED_NOTE =
  "These choices are authorised now, against your role, and applied to every post this series produces later — even if your role changes.";

export const NO_PLACEHOLDERS_HINT = "Don't use {{placeholders}} — a standing series has no per-post data yet.";

export const IMAGE_PROMPT_HINT =
  "Docket adds an instruction never to depict a real, identifiable person. Nothing from the post text, your brand fields or the voice profile is sent to the image provider.";

export const CADENCE_HINT = (zone: string): string =>
  `Between 1 and 10 posts per period. A week starts Monday, a month on the 1st, in this project's time zone (${zone}).`;
