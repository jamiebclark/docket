import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { TrendChart } from "@/components/insights/TrendChart";
import { ComparisonCard } from "@/components/insights/ComparisonCard";
import { docsUrl } from "@/lib/docs";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { buildAccountTrends, buildComparisons, type TrendNote } from "@/server/services/insights/view";

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

  const [{ series, trendNotes }, comparisons] =
    activeAccounts.length === 0
      ? [{ series: [], trendNotes: [] }, []]
      : await Promise.all([
          buildAccountTrends({
            projectId: scope.project.id,
            timeZone: scope.project.timezone,
            accounts: activeAccounts.map((a) => ({ id: a.id, displayName: a.displayName, providerKey: a.providerKey })),
            range,
            accountMetricPollStates: scope.accountMetricPollStates,
          }),
          buildComparisons({ projectId: scope.project.id, timeZone: scope.project.timezone, range }),
        ]);

  return (
    <div>
      <PageHeader title="Insights" description={`Account trends over the last ${RANGE_DAYS} days.`} />
      {activeAccounts.length === 0 ? (
        <EmptyState icon="insights" message="Connect an account, publish a post, then wait for the first scheduled read to see trends here." />
      ) : series.length === 0 && trendNotes.length === 0 ? (
        <EmptyState icon="insights" message="No readings yet. Once a scheduled read succeeds, trends will show up here." />
      ) : (
        <div className="flex flex-col gap-6">
          {series.map((s) => (
            <Card key={`${s.accountId}-${s.metricKey}`}>
              <TrendChart series={s} timeZone={scope.project.timezone} />
            </Card>
          ))}
          {trendNotes.map((note, i) => (
            <Card key={i}>
              <TrendNoteCard note={note} />
            </Card>
          ))}
          {comparisons.map((c) => (
            <Card key={`${c.dimension}-${c.providerKey}-${c.metricKey}`}>
              <ComparisonCard comparison={c} />
            </Card>
          ))}
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
