// components/insights/FirstEngagementCard: how long before anybody noticed (US6,
// contracts/first-engagement.md §4-§5). Every figure states its own source and resolution; `none_yet`
// and `never_observed` are counted separately, never averaged in as zero.
import type { FirstEngagementEntry, FirstEngagementView } from "@/server/services/insights/view";

function humanizeMs(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

function describeFigure(figure: FirstEngagementEntry["figure"]): string {
  switch (figure.kind) {
    case "exact":
      return `${humanizeMs(figure.afterMs)} after publication, exact — from the inbox`;
    case "bounded":
      return `between ${humanizeMs(figure.afterAtLeastMs)} and ${humanizeMs(figure.afterAtMostMs)} after publication — from automatic snapshots`;
    case "within_first_reading":
      return `within ${humanizeMs(figure.afterAtMostMs)} after publication (upper bound only — already present in the first reading)`;
    case "none_yet":
      return `no engagement observed yet, as of ${figure.asOf.toLocaleString()}`;
    case "never_observed":
      return `never observed (stopped being read as ${figure.frozenReason})`;
    case "not_examined":
      return "not yet examined";
  }
}

export function FirstEngagementCard({ view }: { view: FirstEngagementView }) {
  if (view.entries.length === 0) return null;

  const observed = view.entries.filter((e) => e.figure.kind === "exact" || e.figure.kind === "bounded" || e.figure.kind === "within_first_reading");
  const noneYet = view.entries.filter((e) => e.figure.kind === "none_yet");
  const neverObserved = view.entries.filter((e) => e.figure.kind === "never_observed");
  const notExamined = view.entries.filter((e) => e.figure.kind === "not_examined");

  return (
    <div>
      <h3 className="text-sm font-semibold text-heading">How long before anybody noticed</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Exact times exist only for platforms with an engagement reader
        {view.exactCapablePlatforms.length > 0 ? ` (${view.exactCapablePlatforms.join(", ")})` : ""}; every other platform&apos;s figure is a
        snapshot bound whose resolution is the poll cadence.
      </p>

      <ul className="mt-3 flex flex-col gap-1 text-sm">
        {observed.map((entry) => (
          <li key={entry.targetId}>
            <span className="font-medium text-heading">
              {entry.accountName} · {entry.platform}
            </span>
            : {describeFigure(entry.figure)}
          </li>
        ))}
      </ul>

      <ul className="mt-3 flex flex-col gap-0.5 text-xs text-muted-foreground">
        {observed.length > 0 ? <li>{observed.length} post{observed.length === 1 ? "" : "s"} with engagement observed.</li> : null}
        {noneYet.length > 0 ? <li>{noneYet.length} post{noneYet.length === 1 ? "" : "s"} with no engagement yet.</li> : null}
        {neverObserved.length > 0 ? <li>{neverObserved.length} post{neverObserved.length === 1 ? "" : "s"} never observed.</li> : null}
        {notExamined.length > 0 ? <li>{notExamined.length} post{notExamined.length === 1 ? "" : "s"} not yet examined.</li> : null}
      </ul>
    </div>
  );
}
