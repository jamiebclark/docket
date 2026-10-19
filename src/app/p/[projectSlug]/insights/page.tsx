import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { TrendChart } from "@/components/insights/TrendChart";
import { ComparisonCard } from "@/components/insights/ComparisonCard";
import { FirstEngagementCard } from "@/components/insights/FirstEngagementCard";
import { docsUrl } from "@/lib/docs";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { buildAccountTrends, buildComparisons, buildFirstEngagement, type TrendNote } from "@/server/services/insights/view";

export const metadata: Metadata = { title: "Insights" };
export const dynamic = "force-dynamic";

const RANGE_DAYS = 30;
const DAY_MS = 86_400_000;

export default async function InsightsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!scope.can({ post: ["view"] })) notFound();

  const activeAccounts = (await scope.accounts.list()).filter((a) => a.removedAt === null);
  const now = new Date();
  const range = { from: new Date(now.getTime() - RANGE_DAYS * DAY_MS), to: now };

  const [{ series, trendNotes }, comparisons, firstEngagement] =
    activeAccounts.length === 0
      ? [{ series: [], trendNotes: [] }, [], { entries: [], exactCapablePlatforms: [] }]
      : await Promise.all([
          buildAccountTrends({
            projectId: scope.project.id,
            timeZone: scope.project.timezone,
            accounts: activeAccounts.map((a) => ({ id: a.id, displayName: a.displayName, providerKey: a.providerKey })),
            range,
            accountMetricPollStates: scope.accountMetricPollStates,
          }),
          buildComparisons({ projectId: scope.project.id, timeZone: scope.project.timezone, range }),
          buildFirstEngagement({ projectId: scope.project.id, timeZone: scope.project.timezone, range }),
        ]);

  // A metric with no readings yet said "No readings in this range yet." in a card of its own, so a
  // project awaiting its first poll showed a column of identical cards. Those collapse to one line;
  // only series that actually have something to show get a chart.
  const withReadings = series.filter((s) => s.points.length > 0);
  const awaiting = series.filter((s) => s.points.length === 0);
  const byAccount = [...Map.groupBy(withReadings, (s) => s.accountId).entries()];

  return (
    <div>
      <PageHeader title="Insights" description={`The last ${RANGE_DAYS} days, per account and per platform. Numbers are never added together across platforms.`} />
      {activeAccounts.length === 0 ? (
        <EmptyState icon="insights" message="Connect an account, publish a post, then wait for the first scheduled read to see trends here." />
      ) : series.length === 0 && trendNotes.length === 0 ? (
        <EmptyState icon="insights" message="No readings yet. Once a scheduled read succeeds, trends will show up here." />
      ) : (
        <div className="flex flex-col gap-10">
          {/*
            Three sections, not one flat list. Every card used to carry the same visual weight — a
            follower trend, a "cannot plot" note and a slot comparison all looked alike — so the
            page read as an undifferentiated scroll. Headings give it a shape a reader can skim,
            and the trends are grouped by account so an account's name is stated once.
          */}
          {withReadings.length > 0 || awaiting.length > 0 ? (
            <section aria-labelledby="insights-trends">
              <h2 id="insights-trends" className="text-base font-semibold text-heading">
                Account trends
              </h2>
              <div className="mt-3 flex flex-col gap-6">
                {byAccount.map(([accountId, group]) => (
                  <Card key={accountId}>
                    <div className="flex flex-col gap-6">
                      {group.map((s) => (
                        <TrendChart key={`${s.accountId}-${s.metricKey}`} series={s} timeZone={scope.project.timezone} />
                      ))}
                    </div>
                  </Card>
                ))}
                {awaiting.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {awaiting.length} other metric{awaiting.length === 1 ? "" : "s"} across{" "}
                    {new Set(awaiting.map((s) => s.accountId)).size} account
                    {new Set(awaiting.map((s) => s.accountId)).size === 1 ? "" : "s"} {awaiting.length === 1 ? "is" : "are"} awaiting a
                    first reading.
                  </p>
                ) : null}
              </div>
            </section>
          ) : null}

          {comparisons.length > 0 ? (
            <section aria-labelledby="insights-comparisons">
              <h2 id="insights-comparisons" className="text-base font-semibold text-heading">
                What is working
              </h2>
              <div className="mt-3 flex flex-col gap-6">
                {comparisons.map((c) => (
                  <Card key={`${c.dimension}-${c.providerKey}-${c.metricKey}`}>
                    <ComparisonCard comparison={c} />
                  </Card>
                ))}
              </div>
            </section>
          ) : null}

          {firstEngagement.entries.length > 0 ? (
            <section aria-labelledby="insights-first-engagement">
              <h2 id="insights-first-engagement" className="text-base font-semibold text-heading">
                Time to first reply
              </h2>
              <Card className="mt-3">
                <FirstEngagementCard view={firstEngagement} />
              </Card>
            </section>
          ) : null}

          {/* The notes were full-width cards interleaved with the data; they are reference, not findings. */}
          {trendNotes.length > 0 ? (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground underline-offset-2 hover:underline">
                What cannot be plotted ({trendNotes.length})
              </summary>
              <div className="mt-3 flex flex-col gap-2">
                {trendNotes.map((note, i) => (
                  <TrendNoteCard key={i} note={note} />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** FR-015 and US1.6: a line stating what Docket cannot plot, never an empty chart or a zero. */
function TrendNoteCard({ note }: { note: TrendNote }) {
  if (note.kind === "platform_no_account_metrics") {
    return (
      <p className="text-sm text-muted-foreground">
        {note.platform} reports no account numbers.{" "}
        <a href={docsUrl("insights")} target="_blank" rel="noopener noreferrer" className="underline">
          Learn more
        </a>
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      {note.platform} · {note.label}: {note.reason}
    </p>
  );
}
