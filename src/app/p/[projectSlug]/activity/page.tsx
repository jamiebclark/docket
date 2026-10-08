import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityFilters } from "@/components/activity/ActivityFilters";
import { ActivitySummary } from "@/components/activity/ActivitySummary";
import { ActivityList } from "@/components/activity/ActivityList";
import { Alert } from "@/components/ui/Alert";
import { buttonStyles } from "@/components/ui/Button";
import { CursorPagination } from "@/components/ui/CursorPagination";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { listProjectActivity, type ActivityPage } from "@/server/services/activity";
import { filterToSearchParams } from "@/server/services/activity/filters";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function hrefWith(slug: string, page: ActivityPage, key: "before" | "after", cursor: string | null): string | null {
  if (!cursor) return null;
  const qs = filterToSearchParams(page.filter);
  qs.set(key, cursor);
  return `/p/${slug}/activity?${qs.toString()}`;
}

export default async function ActivityPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const page = await listProjectActivity(scope, { ...raw, cursor: first(raw.before) ?? first(raw.after) });
  const zone = scope.project.timezone;
  const f = page.filter;
  const filtered = Boolean(f.outcomes || f.platform || f.accountId || f.range || f.from || f.to);

  return (
    <section>
      <PageHeader
        title="Activity"
        description={`Everything that happened to publishing in this project. Times are in ${zone}.`}
      />
      <ActivityFilters
        basePath={`/p/${projectSlug}/activity`}
        filter={page.filter}
        platforms={page.platforms}
        accounts={page.accounts}
        timeZone={zone}
      />
      <ActivitySummary summary={page.summary} filter={page.filter} basePath={`/p/${projectSlug}/activity`} />
      {page.invalidRange ? (
        <Alert tone="warning" role="alert">
          The start date is after the end date.
        </Alert>
      ) : page.rows.length === 0 ? (
        filtered ? (
          <EmptyState
            message="No activity matches these filters."
            action={
              <Link href={`/p/${projectSlug}/activity`} className={buttonStyles({ variant: "secondary" })}>
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            message="Nothing has happened here yet. Published posts, failures and account problems will appear as they happen."
            action={
              <Link href={`/p/${projectSlug}/compose`} className={buttonStyles({ variant: "primary" })}>
                Compose a post
              </Link>
            }
          />
        )
      ) : (
        <>
          <ActivityList rows={page.rows} caption="Publishing activity, newest first" />
          <CursorPagination
            newerHref={hrefWith(projectSlug, page, "after", page.newer)}
            olderHref={hrefWith(projectSlug, page, "before", page.older)}
          />
        </>
      )}
    </section>
  );
}
