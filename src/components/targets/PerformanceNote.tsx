import { docsHref } from "@/lib/docs";
import type { TargetInsightsView } from "@/lib/insights/panel";
import { LocalTime } from "@/components/ui/LocalTime";

/**
 * Why one account has no numbers, in the account's own words — the explanatory half of
 * `TargetInsightsView` (contracts/panel.md §2–§3). A server component: no `"use client"`, no fetch,
 * no polling.
 *
 * The *numbers* half now lives in `PerformanceOverlay`, which lays every account's readings out as
 * one matrix. This renders nothing for a state that carries its own figures, because the matrix has
 * already shown them; it exists for the states that carry a sentence instead. No chart, trend,
 * delta or total — the view type holds at most one snapshot, so there is never a second value to
 * compare against.
 */
export function PerformanceNote({ view, platform, timeZone }: { view: TargetInsightsView; platform: string; timeZone: string }) {
  switch (view.state) {
    // Its column of figures has already said everything this state has to say.
    case "reported":
      return null;
    case "not_published":
      return <p>Not published yet, so there is nothing to read numbers from.</p>;
    case "platform_unsupported":
      return <p>Docket cannot read numbers from {platform} yet.</p>;
    case "unavailable":
    case "permission_not_requested":
      return <Reason reason={view.reason} docsPath={view.docsPath} />;
    case "needs_reconnect":
      return <Reason reason={view.reason} docsPath={view.docsPath} />;
    case "no_external_id":
      return <p>This was recorded as published by hand, so there is no post on {platform} to read numbers from.</p>;
    case "gone":
      return <p>This post is no longer on {platform}.</p>;
    case "unqueryable":
      return <p>{view.reason}</p>;
    case "expired":
      return <p>This story has expired; these numbers are final.</p>;
    case "failing":
      return (
        <p>
          Reads have been failing since <LocalTime value={view.since} timeZone={timeZone} />: {view.reason}
        </p>
      );
    case "not_polled_yet":
      return (
        <p>
          The numbers have not been read yet. First read due{" "}
          {view.firstReadDueAt ? <LocalTime value={view.firstReadDueAt} timeZone={timeZone} /> : "shortly"}.
        </p>
      );
    case "nothing_reported":
      return (
        <p>
          {platform} reports no numbers for this post, as of <LocalTime value={view.capturedAt} timeZone={timeZone} />.
        </p>
      );
  }
}

function Reason({ reason, docsPath }: { reason: string; docsPath?: string }) {
  return (
    <p>
      {reason}{" "}
      {docsPath ? (
        <a href={docsHref(docsPath)} target="_blank" rel="noopener noreferrer" className="underline">
          Learn more
        </a>
      ) : null}
    </p>
  );
}
