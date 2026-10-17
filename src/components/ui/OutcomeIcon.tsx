import { OUTCOME_LABEL, OUTCOME_TONE, type ActivityOutcome } from "@/lib/activity/outcomes";
import { badgeTones } from "./Badge";
import { Icon, type IconName } from "./Icon";

/**
 * One glyph per outcome, distinct in **shape** and not only in tint — three outcomes share the
 * `danger` tone, so colour could never tell them apart on its own.
 */
const OUTCOME_GLYPH: Record<ActivityOutcome, IconName> = {
  published: "circleCheck",
  failed: "failures",
  ambiguous: "circleAlert",
  retrying: "refresh",
  resolved: "check",
  needs_reauth: "key",
  connect_failed: "close",
  engagement: "inbox",
};

/**
 * The outcome as a fixed-size tinted disc, for a corner that must not move: an outcome label runs
 * from "Failed" to "Needs your decision", and as a badge the long ones wrapped to a second line and
 * dragged the row's top-right corner down with them.
 *
 * **This does not replace the words.** `Badge` always carries text, and §1 of the design system says
 * status is text plus colour — so wherever this is used the outcome label must still appear as text
 * nearby (in `NotificationList` it leads the row's quiet line). What is dropped here is the *second*
 * rendering of the same word, not the only one. The label rides along as `title` and `sr-only` text,
 * so the disc is never the sole carrier for a screen reader either.
 */
export function OutcomeIcon({ outcome, size = 24 }: { outcome: ActivityOutcome; size?: number }) {
  return (
    <span
      title={OUTCOME_LABEL[outcome]}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center rounded-full border ${badgeTones[OUTCOME_TONE[outcome]].pill}`}
    >
      <Icon name={OUTCOME_GLYPH[outcome]} size={Math.round(size * 0.6)} />
      <span className="sr-only">{OUTCOME_LABEL[outcome]}</span>
    </span>
  );
}
