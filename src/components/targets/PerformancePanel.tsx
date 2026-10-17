import { Fragment } from "react";
import type { DocPage } from "@/lib/docs";
import { docsUrl } from "@/lib/docs";
import type { TargetInsightsView } from "@/lib/insights/panel";
import { LocalTime } from "@/components/ui/LocalTime";

/**
 * Renders every state of `TargetInsightsView` (contracts/panel.md §2–§3). A server component: no
 * `"use client"`, no fetch, no polling. No chart, trend, delta or total — the view type carries at
 * most one snapshot, so there is never a second value to compare against.
 */
export function PerformancePanel({ view, platform, timeZone }: { view: TargetInsightsView; platform: string; timeZone: string }) {
  if (view.state === "not_published") return null;

  return (
    <div>
      <h3 className="mt-4 text-sm font-semibold">Performance</h3>
      <div className="mt-1 text-sm">{body(view, platform, timeZone)}</div>
    </div>
  );
}

function body(view: Exclude<TargetInsightsView, { state: "not_published" }>, platform: string, timeZone: string) {
  switch (view.state) {
    case "platform_unsupported":
      return <p>Docket cannot read numbers from {platform} yet.</p>;
    case "unavailable":
      return (
        <p>
          {view.reason}{" "}
          {view.docsPath ? (
            <a href={docsUrl(view.docsPath as DocPage)} target="_blank" rel="noopener noreferrer" className="underline">
              Learn more
            </a>
          ) : null}
        </p>
      );
    case "no_external_id":
      return <p>This was recorded as published by hand, so there is no post on {platform} to read numbers from.</p>;
    case "gone":
      return (
        <>
          <p>This post is no longer on {platform}.</p>
          {view.snapshot ? <Rows rows={view.snapshot.rows} capturedAt={view.snapshot.capturedAt} timeZone={timeZone} /> : null}
        </>
      );
    case "failing":
      return (
        <>
          <p>
            Reads have been failing since <LocalTime value={view.since} timeZone={timeZone} />: {view.reason}
          </p>
          {view.snapshot ? <Rows rows={view.snapshot.rows} capturedAt={view.snapshot.capturedAt} timeZone={timeZone} /> : null}
        </>
      );
    case "not_polled_yet":
      return <p>The numbers have not been read yet. First read due {view.firstReadDueAt ? <LocalTime value={view.firstReadDueAt} timeZone={timeZone} /> : "shortly"}.</p>;
    case "nothing_reported":
      return (
        <>
          <p>{platform} reports no numbers for this post.</p>
          <p className="mt-1 text-muted-foreground">
            As of <LocalTime value={view.capturedAt} timeZone={timeZone} />
          </p>
        </>
      );
    case "reported":
      return <Rows rows={view.rows} capturedAt={view.capturedAt} timeZone={timeZone} />;
  }
}

function Rows({ rows, capturedAt, timeZone }: { rows: { label: string; value: number }[]; capturedAt: Date; timeZone: string }) {
  return (
    <>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt className="font-medium">{row.label}</dt>
            <dd>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="mt-1 text-muted-foreground">
        As of <LocalTime value={capturedAt} timeZone={timeZone} />
      </p>
    </>
  );
}
