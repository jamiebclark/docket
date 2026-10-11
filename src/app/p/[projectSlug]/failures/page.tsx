import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AttemptLogDetails } from "@/components/targets/AttemptLog";
import { RetryAllFailed } from "@/components/targets/RetryAllFailed";
import { TargetResolution } from "@/components/targets/TargetResolution";
import { AnnounceProvider } from "@/components/ui/Announce";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { LocalTime } from "@/components/ui/LocalTime";
import { Pagination } from "@/components/ui/Pagination";
import { Cell, DetailRow, Row, RowGroup, Sub, Table } from "@/components/ui/Table";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { countPosts } from "@/server/services/posts";
import { listFailures, failuresQuerySchema, type FailureList, type FailureRow } from "@/server/services/failures";
import { buttonStyles } from "@/components/ui/Button";
import { ChoiceField } from "@/components/ui/ChoiceField";

export const metadata: Metadata = { title: "Failures" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const KIND_LABEL = { slot: "Queue slot", explicit: "Chosen time", now: "Publish now" } as const;

/** Who, what, why and what to do about it — one column each (design system §7). */
const COLUMNS = ["Account", "Post", "Problem", "Actions"];
const GROUPS = [
  { status: "ambiguous", heading: "Needs your decision", tone: "warning" },
  { status: "failed", heading: "Failed", tone: "danger" },
] as const;

function hrefFor(slug: string, status: string, account: string | undefined, page?: number): string {
  const qs = new URLSearchParams();
  if (status !== "all") qs.set("status", status);
  if (account) qs.set("account", account);
  if (page && page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return `/p/${slug}/failures${s ? `?${s}` : ""}`;
}

function AccountCell({ row }: { row: FailureRow }) {
  return (
    <>
      <div>{row.account.name}</div>
      {row.account.providerName ? <Sub>{row.account.providerName}</Sub> : null}
      {row.account.status === "removed" ? <Badge tone="danger">Removed account</Badge> : null}
      {row.account.status === "needs_reauth" ? <Badge tone="warning">Reconnect needed</Badge> : null}
    </>
  );
}

/** The post, with when and how it was meant to go out under it. */
function PostCell({ row, slug, tz }: { row: FailureRow; slug: string; tz: string }) {
  const kind = row.scheduleKind ? KIND_LABEL[row.scheduleKind] : null;
  return (
    <>
      <Link href={`/p/${slug}/posts/${row.postId}`} className="underline">
        {row.excerpt || "(no text)"}
      </Link>
      {row.intendedAt || kind ? (
        <Sub>
          {row.intendedAt ? (
            <>
              Due <LocalTime value={row.intendedAt} timeZone={tz} />
            </>
          ) : (
            "No time set"
          )}
          {kind ? ` · ${kind}` : ""}
        </Sub>
      ) : null}
    </>
  );
}

export default async function FailuresPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const query = failuresQuerySchema.parse({ status: first(raw.status), account: first(raw.account), target: first(raw.target), page: first(raw.page) });
  let list: FailureList | null = null;
  try {
    list = await listFailures(scope, query);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    list = null;
  }
  const tz = scope.project.timezone;
  const canSchedule = scope.can({ post: ["schedule"] });
  const tabs = [
    { key: "all", label: "All" },
    { key: "ambiguous", label: "Needs your decision" },
    { key: "failed", label: "Failed" },
  ].map((t) => ({
    label: t.label,
    href: hrefFor(projectSlug, t.key, query.account),
    active: t.key === query.status,
    ...(list ? { count: t.key === "all" ? list.totals.ambiguous + list.totals.failed : list.totals[t.key as "ambiguous" | "failed"] } : {}),
  }));
  const empty = list !== null && list.rows.length === 0;
  const filtered = query.status !== "all" || !!query.account || !!query.target;
  const noPosts = empty && !filtered ? (await countPosts(scope).catch(() => 1)) === 0 : false;
  const groups = list ? GROUPS.map((g) => ({ ...g, rows: list!.rows.filter((r) => r.status === g.status) })).filter((g) => g.rows.length > 0) : [];

  return (
    <AnnounceProvider focusFallbackId="page-title">
    <section>
      <PageHeader
        title="Failures"
        titleId="page-title"
        description={`Posts that didn't go out, and what you can do about them. Times are in ${tz}.`}
      />
      {list && !noPosts ? (
        <p className="mt-1 text-sm">
          {list.totals.ambiguous} need your decision · {list.totals.failed} failed
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        {noPosts ? null : query.target ? (
          <Link href={`/p/${projectSlug}/failures`} className="text-sm underline">
            Show all failures
          </Link>
        ) : (
          <FilterTabs label="Filter failures by status" tabs={tabs} />
        )}
        {list && !noPosts ? (
          <form method="get" action={`/p/${projectSlug}/failures`} className="flex items-end gap-2">
            {query.status !== "all" ? <input type="hidden" name="status" value={query.status} /> : null}
            <ChoiceField
              id="failures-account"
              name="account"
              label="Account"
              compact
              autoSubmit
              defaultValue={query.account ?? ""}
              options={[{ value: "", label: "All accounts" }, ...list.accounts.map((a) => ({ value: a.id, label: a.name }))]}
            />
            <noscript>
              <button type="submit" className={buttonStyles({ variant: "secondary" })}>
                Apply
              </button>
            </noscript>
          </form>
        ) : null}
        {canSchedule && query.status !== "ambiguous" && list && !noPosts ? (
          <RetryAllFailed
            key={`${query.status}:${query.account ?? ""}`}
            slug={projectSlug}
            accountId={query.account ?? null}
            accountName={query.account ? (list.accounts.find((a) => a.id === query.account)?.name ?? null) : null}
            failedCount={list.failedInFilter}
          />
        ) : null}
      </div>

      <div className="mt-4">
        {list === null ? (
          <p role="alert" className="text-sm text-danger">
            Failures couldn&apos;t be loaded. Reload the page to try again.
          </p>
        ) : empty ? (
          <EmptyState
            message={
              filtered
                ? "No posts match this filter."
                : noPosts
                  ? "Posts that fail to publish will show up here."
                  : "Nothing needs attention. Every post that was due went out or is still scheduled."
            }
            action={
              filtered ? (
                <Link href={`/p/${projectSlug}/failures`} className={buttonStyles({ variant: "secondary" })}>
                  Clear filters
                </Link>
              ) : noPosts ? undefined : (
                <Link href={`/p/${projectSlug}/posts`} className={buttonStyles({ variant: "secondary" })}>
                  View posts
                </Link>
              )
            }
          />
        ) : (
          <>
            <Table caption="Posts that did not go out" columns={COLUMNS} grouped>
              {groups.map((group) => (
                <RowGroup
                  key={group.status}
                  span={COLUMNS.length}
                  heading={<Badge tone={group.tone}>{group.heading}</Badge>}
                >
                  {group.rows.map((row) => (
                    <Fragment key={row.targetId}>
                      <Row id={`target-${row.targetId}`}>
                        <Cell header>
                          <AccountCell row={row} />
                        </Cell>
                        <Cell>
                          <PostCell row={row} slug={projectSlug} tz={tz} />
                        </Cell>
                        <Cell>
                          {row.lastError ?? "—"}
                          <Sub>
                            {row.attemptCount} {row.attemptCount === 1 ? "attempt" : "attempts"}
                          </Sub>
                        </Cell>
                        <Cell>
                          <TargetResolution
                            slug={projectSlug}
                            targetId={row.targetId}
                            accountId={row.account.id}
                            timeZone={tz}
                            accountName={row.account.name}
                            status={row.status}
                            actions={row.actions}
                            canSchedule={canSchedule}
                            variant="row"
                          />
                        </Cell>
                      </Row>
                      <DetailRow span={COLUMNS.length}>
                        <AttemptLogDetails runs={row.attempts} timeZone={tz} caption={`Attempt log for ${row.account.name}`} />
                      </DetailRow>
                    </Fragment>
                  ))}
                </RowGroup>
              ))}
            </Table>
            <Pagination
              page={list.page}
              pageSize={list.pageSize}
              total={list.filtered}
              hrefFor={(p) => hrefFor(projectSlug, query.status, query.account, p)}
            />
          </>
        )}
      </div>
    </section>
    </AnnounceProvider>
  );
}
