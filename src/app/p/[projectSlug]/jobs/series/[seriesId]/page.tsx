import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { LocalDate } from "@/components/ui/LocalDate";
import { LocalTime } from "@/components/ui/LocalTime";
import { Pagination } from "@/components/ui/Pagination";
import { CsvProblemList } from "@/components/ui/CsvProblemList";
import { Cell, Row, Sub, Table } from "@/components/ui/Table";
import { formatMonthDay } from "@/lib/time/format";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { DATED_ROWS_PAGE_SIZE, getStandingSeries } from "@/server/services/standing-series/read";
import { CreditHoldNotice } from "../../CreditHoldNotice";
import { APPROVAL_LABEL, SCHEDULING_LABEL } from "../../../generate/generate-logic";
import { UNREVIEWED_QUEUE_LABEL, isUnreviewedQueue } from "../../../generate/PolicyPicker";
import { SeriesRowActions } from "../SeriesRowActions";
import { DatedListImport } from "../DatedListImport";
import { DatedRowActions } from "../DatedRowActions";
import { AddDatedRowButton } from "../AddDatedRowButton";
import {
  FR064_EXPLANATION,
  accountNames,
  cadenceLabel,
  droppedAccountsLine,
  leadLabel,
  mediaSummary,
  outcomeInfo,
  periodLabel,
  LAST_OUTCOME_LABEL,
  problemLine,
  rowSummary,
  seriesStateInfo,
} from "../series-logic";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string; seriesId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function load(projectSlug: string, seriesId: string, rowsPage: number) {
  try {
    const scope = await forProject(await getSession(), projectSlug);
    return { scope, series: await getStandingSeries(scope, seriesId, { rowsPage }) };
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectSlug, seriesId } = await params;
  const { series } = await load(projectSlug, seriesId, 1);
  return { title: `${series.name} · Standing series` };
}

export default async function StandingSeriesDetailPage({ params, searchParams }: Props) {
  const { projectSlug, seriesId } = await params;
  const raw = await searchParams;
  const rowsPage = Math.max(1, Number.parseInt(Array.isArray(raw.rows) ? raw.rows[0] ?? "1" : raw.rows ?? "1", 10) || 1);
  const { scope, series } = await load(projectSlug, seriesId, rowsPage);
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
          <dt className="font-medium">Occurrence</dt>
          <dd>{series.cadence ? cadenceLabel(series.cadence) : "Dated list"}</dd>
          {series.occurrenceRule === "dated_list" ? (
            <>
              <dt className="font-medium">Lead time</dt>
              <dd>{leadLabel(series.leadDays) === "On the day" ? "Posts are written on the day" : `Posts are written ${series.leadDays} day${series.leadDays === 1 ? "" : "s"} early`}</dd>
            </>
          ) : null}
          <dt className="font-medium">Next due</dt>
          <dd>
            {series.occurrenceRule === "dated_list" ? (
              series.upcoming[0] ? <LocalDate value={series.upcoming[0].target} /> : "No upcoming dates"
            ) : (
              <LocalTime value={series.nextRunAt!} timeZone={tz} />
            )}
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

      {series.occurrenceRule === "dated_list" ? (
        <>
          <Card title="Upcoming dates">
            {series.upcoming.length === 0 ? (
              <EmptyState
                message="No upcoming dates. Import a list to give this series its dates."
                action={canManage ? <DatedListImport slug={projectSlug} seriesId={seriesId} /> : undefined}
              />
            ) : (
              <Table caption="Upcoming dates" columns={["Date", "Row", "Generated"]}>
                {series.upcoming.map((occurrence) => (
                  <Row key={occurrence.rowId}>
                    <Cell header>
                      <LocalDate value={occurrence.target} />
                      <Sub>{occurrence.keyValue}</Sub>
                    </Cell>
                    <Cell>{occurrence.keyValue}</Cell>
                    <Cell>{series.leadDays > 0 ? <LocalTime value={occurrence.dueAt} timeZone={tz} /> : "On the day"}</Cell>
                  </Row>
                ))}
              </Table>
            )}
          </Card>

          {series.lastImport && series.lastImport.problems.length > 0 ? (
            <Alert tone="warning" role="alert">
              {series.lastImport.problems.length} of {series.lastImport.rowCount} rows in {series.lastImport.filename} could not be used
              — <LocalTime value={series.lastImport.at} timeZone={tz} />
              <div className="mt-2">
                <CsvProblemList problems={series.lastImport.problems} />
              </div>
            </Alert>
          ) : null}

          <Card
            title={`Rows (${series.rows.total})`}
            actions={
              canManage ? (
                <div className="flex gap-2">
                  <DatedListImport slug={projectSlug} seriesId={seriesId} />
                  <AddDatedRowButton slug={projectSlug} seriesId={seriesId} templateFields={series.templateFields} />
                </div>
              ) : undefined
            }
          >
            {series.rows.items.length === 0 ? (
              <EmptyState
                message="No rows yet. Import a CSV with a date column and one column per field your instructions use."
                action={canManage ? <DatedListImport slug={projectSlug} seriesId={seriesId} /> : undefined}
              />
            ) : (
              <>
                <Table caption="Rows" columns={["Date", "Row", "Image", "Next due", ...(canManage ? ["Actions"] : [])]}>
                  {series.rows.items.map((r) => (
                    <Row key={r.id}>
                      <Cell header>
                        {r.year === null ? formatMonthDay(r.date) : <LocalDate value={r.date} />}
                        <Sub>{r.year === null ? "every year" : `once, in ${r.year}`}</Sub>
                      </Cell>
                      <Cell>
                        {r.keyValue}
                        <Sub>{rowSummary(r.fields, series.templateFields[0] ?? null)}</Sub>
                      </Cell>
                      <Cell>
                        {r.mediaFilename ? (
                          <>
                            {r.mediaFilename}
                            {r.mediaMissing ? <Badge tone="warning">Not in the library</Badge> : null}
                          </>
                        ) : (
                          <>
                            —<Sub>Series default</Sub>
                          </>
                        )}
                      </Cell>
                      <Cell>
                        {r.nextTargetDate ? <LocalDate value={r.nextTargetDate} /> : "Past"}
                        <Sub>{LAST_OUTCOME_LABEL[r.lastOutcome ?? "none"]}</Sub>
                      </Cell>
                      {canManage ? (
                        <Cell>
                          <DatedRowActions
                            slug={projectSlug}
                            seriesId={seriesId}
                            templateFields={series.templateFields}
                            row={{ id: r.id, date: r.year === null ? r.date : `${r.year}-${r.date}`, media: r.mediaFilename, fields: r.fields }}
                            label={`${formatMonthDay(r.date)}, ${r.keyValue}`}
                          />
                        </Cell>
                      ) : null}
                    </Row>
                  ))}
                </Table>
                <Pagination
                  page={series.rows.page}
                  pageSize={DATED_ROWS_PAGE_SIZE}
                  total={series.rows.total}
                  hrefFor={(p) => `/p/${projectSlug}/jobs/series/${seriesId}?rows=${p}`}
                />
              </>
            )}
          </Card>
        </>
      ) : null}

      <Alert tone="info">{FR064_EXPLANATION}</Alert>

      {series.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {series.nextRunAt ? (
            <>
              No runs yet. The first is due <LocalTime value={series.nextRunAt} timeZone={tz} />.
            </>
          ) : (
            "No runs yet."
          )}
        </p>
      ) : (
        <Table caption="Run history" columns={["Period", "Outcome", "Produced", "Problems"]}>
          {series.runs.map((run) => {
            const dropped = droppedAccountsLine(run.droppedAccountIds);
            return (
              <Row key={run.id}>
                <Cell header>
                  {run.period === "date" ? (
                    <>
                      <LocalDate value={run.periodStart} />
                      <Sub>Dated list</Sub>
                    </>
                  ) : (
                    <>
                      {periodLabel(run.period)} <LocalTime value={run.periodStartAt} timeZone={tz} />
                      <Sub>
                        Opened <LocalTime value={run.openedAt} timeZone={tz} />
                        {run.missedPeriods > 0 ? ` · Missed ${run.missedPeriods} earlier periods` : ""}
                      </Sub>
                    </>
                  )}
                </Cell>
                <Cell>
                  {run.outcome ? (
                    (() => {
                      const info = outcomeInfo(run.outcome, run.requestedCount, run.produced.length);
                      return (
                        <>
                          <Badge tone={info.tone}>{info.label}</Badge>
                          {run.counts.skipped > 0 || run.counts.failed > 0 || run.counts.missed > 0 ? (
                            <Sub>
                              {[
                                run.counts.skipped > 0 ? `${run.counts.skipped} skipped` : null,
                                run.counts.failed > 0 ? `${run.counts.failed} failed` : null,
                                run.counts.missed > 0 ? `${run.counts.missed} missed` : null,
                              ]
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
