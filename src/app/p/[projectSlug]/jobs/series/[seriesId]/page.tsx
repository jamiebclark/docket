import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Sub, Table } from "@/components/ui/Table";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { getStandingSeries } from "@/server/services/standing-series/read";
import { CreditHoldNotice } from "../../CreditHoldNotice";
import { APPROVAL_LABEL, SCHEDULING_LABEL } from "../../../generate/generate-logic";
import { UNREVIEWED_QUEUE_LABEL, isUnreviewedQueue } from "../../../generate/PolicyPicker";
import { SeriesRowActions } from "../SeriesRowActions";
import {
  FR064_EXPLANATION,
  accountNames,
  cadenceLabel,
  droppedAccountsLine,
  mediaSummary,
  outcomeInfo,
  periodLabel,
  problemLine,
  seriesStateInfo,
} from "../series-logic";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string; seriesId: string }> };

async function load(projectSlug: string, seriesId: string) {
  try {
    const scope = await forProject(await getSession(), projectSlug);
    return { scope, series: await getStandingSeries(scope, seriesId) };
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectSlug, seriesId } = await params;
  const { series } = await load(projectSlug, seriesId);
  return { title: `${series.name} · Standing series` };
}

export default async function StandingSeriesDetailPage({ params }: Props) {
  const { projectSlug, seriesId } = await params;
  const { scope, series } = await load(projectSlug, seriesId);
  const tz = scope.project.timezone;
  const canManage = scope.can({ standing_series: ["manage"] });
  const state = seriesStateInfo(series);
  const unreviewedQueue = isUnreviewedQueue({ approval: series.approvalPolicy, scheduling: series.schedulingPolicy });

  return (
    <section className="flex flex-col gap-4">
      <PageHeader
        title={series.name}
        aside={<Badge tone={state.tone}>{state.label}</Badge>}
        actions={
          <SeriesRowActions
            slug={projectSlug}
            seriesId={seriesId}
            name={series.name}
            enabled={series.enabled}
            postCount={series.producedCount}
            timezone={tz}
            canManage={canManage}
          />
        }
      />

      {series.creditHold ? <CreditHoldNotice since={series.creditHold.since} timeZone={tz} scope={series.creditHold.scope} /> : null}

      <Card title="What it is">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium">Cadence</dt>
          <dd>{cadenceLabel(series.cadence)}</dd>
          <dt className="font-medium">Next due</dt>
          <dd>
            <LocalTime value={series.nextRunAt} timeZone={tz} />
          </dd>
          <dt className="font-medium">Last run</dt>
          <dd>{series.lastRunAt ? <LocalTime value={series.lastRunAt} timeZone={tz} /> : "Never"}</dd>
          <dt className="font-medium">Accounts</dt>
          <dd>{accountNames(series.accounts)}</dd>
          <dt className="font-medium">Voice profile</dt>
          <dd>
            {series.voiceProfile.name}
            {series.voiceProfile.archived ? " (archived)" : ""}
          </dd>
          <dt className="font-medium">Review and scheduling</dt>
          <dd>{unreviewedQueue ? UNREVIEWED_QUEUE_LABEL : `${APPROVAL_LABEL[series.approvalPolicy]} + ${SCHEDULING_LABEL[series.schedulingPolicy]}`}</dd>
          <dt className="font-medium">Images</dt>
          <dd>{mediaSummary(series.media)}</dd>
        </dl>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer font-medium">Brief and instructions</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="whitespace-pre-wrap">{series.brief}</p>
            <pre className="whitespace-pre-wrap font-mono text-xs">{series.template}</pre>
          </div>
        </details>
      </Card>

      <Alert tone="info">{FR064_EXPLANATION}</Alert>

      {series.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No runs yet. The first is due <LocalTime value={series.nextRunAt} timeZone={tz} />.
        </p>
      ) : (
        <Table caption="Run history" columns={["Period", "Outcome", "Produced", "Problems"]}>
          {series.runs.map((run) => {
            const dropped = droppedAccountsLine(run.droppedAccountIds);
            return (
              <Row key={run.id}>
                <Cell header>
                  {periodLabel(run.period)} <LocalTime value={run.periodStartAt} timeZone={tz} />
                  <Sub>
                    Opened <LocalTime value={run.openedAt} timeZone={tz} />
                    {run.missedPeriods > 0 ? ` · Missed ${run.missedPeriods} earlier periods` : ""}
                  </Sub>
                </Cell>
                <Cell>
                  {run.outcome ? (
                    (() => {
                      const info = outcomeInfo(run.outcome, run.requestedCount, run.produced.length);
                      return (
                        <>
                          <Badge tone={info.tone}>{info.label}</Badge>
                          {run.counts.skipped > 0 || run.counts.failed > 0 ? (
                            <Sub>
                              {[run.counts.skipped > 0 ? `${run.counts.skipped} skipped` : null, run.counts.failed > 0 ? `${run.counts.failed} failed` : null]
                                .filter(Boolean)
                                .join(" · ")}
                            </Sub>
                          ) : null}
                        </>
                      );
                    })()
                  ) : (
                    <Badge tone="info">In progress</Badge>
                  )}
                </Cell>
                <Cell>
                  {run.produced.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : (
                    run.produced.map((p, i) => (
                      <span key={p.postId}>
                        {i > 0 ? ", " : ""}
                        <Link href={`/p/${projectSlug}/posts/${p.postId}`} className="underline">
                          Post {p.position + 1}
                        </Link>
                      </span>
                    ))
                  )}
                </Cell>
                <Cell>
                  <ul className="flex flex-col gap-0.5">
                    {run.problems.map((problem, i) => (
                      <li key={i}>{problemLine(problem, run.blockedReason)}</li>
                    ))}
                    {dropped ? <li>{dropped}</li> : null}
                  </ul>
                </Cell>
              </Row>
            );
          })}
        </Table>
      )}
    </section>
  );
}
