import { Fragment } from "react";
import { docsHref } from "@/lib/docs";
import type { TargetInsightsView } from "@/lib/insights/panel";
import { LocalTime } from "@/components/ui/LocalTime";

/**
 * One target's numbers for a list row or overview card (FR-021–FR-023): per-target, per-platform,
 * each with its own label and "as of". Renders nothing — no row, no dash, no `0` — for an absent
 * metric or a state with nothing to show. A server component: no fetch, no polling, no chart.
 */
export function TargetMetrics({ view, platform, timeZone }: { view: TargetInsightsView; platform: string; timeZone: string }) {
  switch (view.state) {
    case "not_published":
    case "platform_unsupported":
      return null;
    case "unavailable":
    case "permission_not_requested":
    case "needs_reconnect":
      return <Reason text={view.reason} docsPath={view.docsPath} />;
    case "no_external_id":
      return <p className="text-xs text-muted-foreground">No post on {platform} to read numbers from.</p>;
    case "gone":
      return view.snapshot ? <Rows rows={view.snapshot.rows} capturedAt={view.snapshot.capturedAt} timeZone={timeZone} /> : <p className="text-xs text-muted-foreground">No longer on {platform}.</p>;
    case "unqueryable":
      return view.snapshot ? <Rows rows={view.snapshot.rows} capturedAt={view.snapshot.capturedAt} timeZone={timeZone} /> : <p className="text-xs text-muted-foreground">{view.reason}</p>;
    case "expired":
      return view.snapshot ? <Rows rows={view.snapshot.rows} capturedAt={view.snapshot.capturedAt} timeZone={timeZone} /> : <p className="text-xs text-muted-foreground">Expired.</p>;
    case "failing":
      return view.snapshot ? (
        <Rows rows={view.snapshot.rows} capturedAt={view.snapshot.capturedAt} timeZone={timeZone} />
      ) : (
        <p className="text-xs text-muted-foreground">
          Reads have been failing since <LocalTime value={view.since} timeZone={timeZone} />.
        </p>
      );
    case "not_polled_yet":
      return <p className="text-xs text-muted-foreground">Not polled yet.</p>;
    case "nothing_reported":
      return (
        <p className="text-xs text-muted-foreground">
          {platform} reports nothing. As of <LocalTime value={view.capturedAt} timeZone={timeZone} />
        </p>
      );
    case "reported":
      return <Rows rows={view.rows} capturedAt={view.capturedAt} timeZone={timeZone} />;
  }
}

function Reason({ text, docsPath }: { text: string; docsPath?: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {text}{" "}
      {docsPath ? (
        <a href={docsHref(docsPath)} target="_blank" rel="noopener noreferrer" className="underline">
          Learn more
        </a>
      ) : null}
    </p>
  );
}

function Rows({ rows, capturedAt, timeZone }: { rows: { label: string; value: number }[]; capturedAt: Date; timeZone: string }) {
  if (rows.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <div className="flex items-baseline gap-1">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="font-medium">{row.value}</dd>
          </div>
        </Fragment>
      ))}
      <div className="w-full text-muted-foreground">
        As of <LocalTime value={capturedAt} timeZone={timeZone} />
      </div>
    </dl>
  );
}
