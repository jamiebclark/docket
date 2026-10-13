import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ForbiddenError, forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { USAGE_PURPOSE_LABELS } from "@/lib/generation/usage-purpose";
import { DEFAULT_USAGE_PERIOD, USAGE_PERIODS, type UsagePeriod } from "@/lib/generation/usage-period";
import { ESTIMATE_DISCLAIMER, getProjectUsage, type UsageView } from "@/server/services/usage";
import { formatMoney } from "@/server/llm/rates";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { LocalTime } from "@/components/ui/LocalTime";
import { Cell, Row, Sub, Table } from "@/components/ui/Table";

/**
 * Resolved per request, not static — a static `metadata` renders even when the page itself calls
 * `notFound()`, so an editor who may not manage credentials would still see a document titled
 * "Usage · Docket", naming a page they are not allowed to know about.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}): Promise<Metadata> {
  const { projectSlug } = await params;
  const scope = await forProject(await getSession(), projectSlug).catch(() => null);
  const mayManage = scope?.can({ llm_credential: ["manage"] }) ?? false;
  return { title: mayManage ? "Usage" : "Not found" };
}
export const dynamic = "force-dynamic";

const PERIOD_LABEL: Record<UsagePeriod, string> = {
  "30d": "Last 30 days",
  month: "This month",
  "last-month": "Last month",
  all: "All time",
};

function periodHref(slug: string, period: UsagePeriod): string {
  return period === DEFAULT_USAGE_PERIOD ? `/p/${slug}/settings/usage` : `/p/${slug}/settings/usage?period=${period}`;
}

/** "Covers 1 priced model. Leaves out 94 calls and 29,006 tokens on anthropic:<model>." (FR-022). */
function moneyCoverageSentence(money: NonNullable<UsageView["money"]>): string {
  const covers = `Covers ${money.pricedModels.toLocaleString("en-US")} priced model${money.pricedModels === 1 ? "" : "s"}.`;
  if (money.excluded.length === 0) return covers;
  const calls = money.excluded.reduce((n, row) => n + row.calls, 0);
  const tokens = money.excluded.reduce((n, row) => n + row.tokens, 0);
  const models = money.excluded.map((row) => `${row.provider}:${row.model}`).join(", ");
  return `${covers} Leaves out ${calls.toLocaleString("en-US")} call${calls === 1 ? "" : "s"} and ${tokens.toLocaleString("en-US")} token${tokens === 1 ? "" : "s"} on ${models}.`;
}

export default async function UsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  const rawPeriod = Array.isArray(raw.period) ? raw.period[0] : raw.period;
  const period: UsagePeriod = USAGE_PERIODS.includes(rawPeriod as UsagePeriod) ? (rawPeriod as UsagePeriod) : DEFAULT_USAGE_PERIOD;

  const session = await getSession();
  let view;
  try {
    const scope = await forProject(session, projectSlug);
    view = await getProjectUsage(scope, period);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  }

  const tabs = USAGE_PERIODS.map((p) => ({
    label: PERIOD_LABEL[p],
    href: periodHref(projectSlug, p),
    active: p === period,
  }));

  const { totals } = view;
  const empty = totals.calls === 0;
  const purposeRows = view.byPurpose.filter((p) => p.calls > 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Usage"
        description="What this project's generations have asked of the model, and what it would cost at the rates this install has configured."
      />
      <FilterTabs label="Filter usage by period" tabs={tabs} />
      <p className="text-sm text-muted-foreground">
        {view.window.from && view.window.to ? (
          <>
            <LocalTime value={view.window.from} timeZone={view.timeZone} /> to{" "}
            <LocalTime value={view.window.to} timeZone={view.timeZone} /> ({view.timeZone})
          </>
        ) : (
          <>All time, in {view.timeZone}.</>
        )}
      </p>

      {empty ? (
        <EmptyState
          message="No model calls have been recorded for this period."
          action={<p className="text-sm text-muted-foreground">Try a different period above.</p>}
        />
      ) : (
        <>
          <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Model calls</dt>
                <dd className="text-2xl font-semibold tabular-nums">{totals.calls.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Input tokens</dt>
                <dd className="text-2xl font-semibold tabular-nums">{totals.inputTokens.toLocaleString("en-US")}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Output tokens</dt>
                <dd className="text-2xl font-semibold tabular-nums">{totals.outputTokens.toLocaleString("en-US")}</dd>
              </div>
              {view.money && !view.money.noPricedUsage ? (
                <div>
                  <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Estimated upper bound</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{formatMoney(view.money.totalMicros, view.money.currency)}</dd>
                </div>
              ) : null}
            </dl>
            <div className="mt-3 flex flex-col gap-1 text-sm text-muted-foreground">
              {totals.callsWithoutCounts > 0 ? (
                <p>
                  {totals.callsWithoutCounts.toLocaleString("en-US")} call{totals.callsWithoutCounts === 1 ? "" : "s"} reported no token
                  counts and are left out of the token figures.
                </p>
              ) : null}
              {totals.failedCalls > 0 ? (
                <p>
                  {totals.failedCalls.toLocaleString("en-US")} call{totals.failedCalls === 1 ? "" : "s"} produced nothing (
                  {(totals.failedInputTokens + totals.failedOutputTokens).toLocaleString("en-US")} tokens).
                </p>
              ) : null}
              <p>
                {totals.projectCredentialCalls.toLocaleString("en-US")} on this project&apos;s own credential,{" "}
                {totals.installCredentialCalls.toLocaleString("en-US")} on the install&apos;s.
              </p>
            </div>
          </div>

          {view.money && !view.money.noPricedUsage ? (
            <Alert tone="info">
              {ESTIMATE_DISCLAIMER} Estimates use the rates configured now.{" "}
              {moneyCoverageSentence(view.money)}
            </Alert>
          ) : view.money ? (
            <Alert tone="info">No model used in this period has a rate configured, so no estimate is shown.</Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              Money can be shown once an operator sets <code>LLM_RATES</code> and <code>LLM_RATE_CURRENCY</code> for this install. Calls
              and tokens above need no configuration.
            </p>
          )}

          <Table caption="Usage by model" columns={view.money ? ["Model", "Calls", "Tokens", "Estimate"] : ["Model", "Calls", "Tokens"]}>
            {view.byModel.map((row) => (
              <Row key={`${row.provider}:${row.model}`}>
                <Cell header>
                  <div>{row.model}</div>
                  <Sub>{row.provider}</Sub>
                </Cell>
                <Cell>
                  <div>{row.calls.toLocaleString("en-US")}</div>
                  {row.failedCalls > 0 ? <Sub>{row.failedCalls.toLocaleString("en-US")} produced nothing</Sub> : null}
                  {row.callsWithoutCounts > 0 ? <Sub>{row.callsWithoutCounts.toLocaleString("en-US")} reported no counts</Sub> : null}
                </Cell>
                <Cell>
                  <div>{row.inputTokens.toLocaleString("en-US")} in</div>
                  <Sub>{row.outputTokens.toLocaleString("en-US")} out</Sub>
                </Cell>
                {view.money ? (
                  <Cell>
                    {row.estimateMicros !== undefined ? (
                      <>
                        <div>{formatMoney(row.estimateMicros, view.money.currency)}</div>
                        {row.rateIsZero ? <Sub>rate configured as zero</Sub> : null}
                      </>
                    ) : (
                      <>
                        <div>No rate configured</div>
                        <Sub>
                          Set LLM_RATES for {row.provider}:{row.model} to price this
                        </Sub>
                      </>
                    )}
                  </Cell>
                ) : null}
              </Row>
            ))}
          </Table>

          <Table caption="Usage by what the calls were for" columns={["What for", "Calls", "Tokens"]}>
            {purposeRows.map((row) => (
              <Row key={row.purpose}>
                <Cell header>{USAGE_PURPOSE_LABELS[row.purpose]}</Cell>
                <Cell>{row.calls.toLocaleString("en-US")}</Cell>
                <Cell>
                  <div>{row.inputTokens.toLocaleString("en-US")} in</div>
                  <Sub>{row.outputTokens.toLocaleString("en-US")} out</Sub>
                </Cell>
              </Row>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}
