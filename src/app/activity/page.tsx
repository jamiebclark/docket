import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ActivityFilters } from "@/components/activity/ActivityFilters";
import { ActivityList } from "@/components/activity/ActivityList";
import { ActivitySummary } from "@/components/activity/ActivitySummary";
import { SignedInHeader } from "@/components/shell/SignedInHeader";
import { Alert } from "@/components/ui/Alert";
import { buttonStyles } from "@/components/ui/Button";
import { CursorPagination } from "@/components/ui/CursorPagination";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { getSession } from "@/server/auth/session";
import { forMyProjects } from "@/server/dal";
import { listMyActivity, type ActivityPage } from "@/server/services/activity";
import { filterToSearchParams } from "@/server/services/activity/filters";

export const metadata: Metadata = { title: "All activity" };
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function hrefWith(page: ActivityPage, key: "before" | "after", cursor: string | null): string | null {
  if (!cursor) return null;
  const qs = filterToSearchParams(page.filter);
  qs.set(key, cursor);
  return `/activity?${qs.toString()}`;
}

export default async function AllActivityPage({ searchParams }: Props) {
  const session = await getSession();
  if (!session) redirect("/login?next=/activity");
  const raw = await searchParams;
  const set = await forMyProjects(session);
  const page = await listMyActivity(set, { ...raw, cursor: first(raw.before) ?? first(raw.after) });
  const f = page.filter;
  const filtered = Boolean(f.outcomes || f.platform || f.accountId || f.range || f.from || f.to || f.projectSlugs);

  return (
    <>
      <SignedInHeader user={session.user} />
      <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-8">
        <PageHeader
          title="All activity"
          description="Everything that happened to publishing across your projects. Each time is in its project's zone."
        />
        {set.projects.length === 0 ? (
          <EmptyState
            message="You are not a member of any project yet."
            action={
              <Link href="/" className={buttonStyles({ variant: "secondary" })}>
                Back to Docket
              </Link>
            }
          />
        ) : (
          <>
            <ActivityFilters
              basePath="/activity"
              filter={page.filter}
              platforms={page.platforms}
              accounts={[]}
              timeZone={null}
              projects={page.projects}
            />
            <ActivitySummary summary={page.summary} filter={page.filter} basePath="/activity" />
            {page.invalidRange ? (
              <Alert tone="warning" role="alert">
                The start date is after the end date.
              </Alert>
            ) : page.rows.length === 0 ? (
              filtered ? (
                <EmptyState
                  message="No activity matches these filters."
                  action={
                    <Link href="/activity" className={buttonStyles({ variant: "secondary" })}>
                      Clear filters
                    </Link>
                  }
                />
              ) : (
                <EmptyState
                  message="Nothing has happened here yet. Published posts, failures and account problems will appear as they happen."
                  action={
                    <Link href="/" className={buttonStyles({ variant: "secondary" })}>
                      Back to your projects
                    </Link>
                  }
                />
              )
            ) : (
              <>
                <ActivityList rows={page.rows} showProject caption="Publishing activity across your projects, newest first" />
                <CursorPagination newerHref={hrefWith(page, "after", page.newer)} olderHref={hrefWith(page, "before", page.older)} />
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
