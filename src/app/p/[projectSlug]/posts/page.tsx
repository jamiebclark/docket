import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { LocalTime } from "@/components/ui/LocalTime";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Cell, Row, Table } from "@/components/ui/Table";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as posts from "@/server/services/posts";
import { POST_LIST_STATUSES, postSearchParamsSchema } from "@/lib/validation/media";
import { buttonStyles } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Posts" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const LABELS: Record<(typeof POST_LIST_STATUSES)[number], string> = {
  draft: "Drafts",
  needs_review: "Needs review",
  approved: "Approved",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  partially_failed: "Partially failed",
  failed: "Failed",
  rejected: "Rejected",
  needs_decision: "Needs your decision",
};

// One list for tabs and parsing, so every status the service supports is reachable (F2).
const FILTERS = [{ key: undefined, label: "All" }, ...POST_LIST_STATUSES.map((key) => ({ key, label: LABELS[key] }))];

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function hrefFor(slug: string, status?: string, page?: number): string {
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (page && page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return `/p/${slug}/posts${s ? `?${s}` : ""}`;
}

export default async function PostsPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const parsedParams = postSearchParamsSchema.parse({ status: first(raw.status), page: first(raw.page) });
  const status = parsedParams.status;
  const page = parsedParams.page ?? 1;
  let list: posts.PostList | null = null;
  try {
    list = await posts.listPosts(scope, { ...(status ? { status } : {}), page });
  } catch {
    list = null;
  }
  const tz = scope.project.timezone;
  const tabs = FILTERS.map((f) => ({
    label: f.label,
    href: hrefFor(projectSlug, f.key),
    active: f.key === status,
    ...(list ? { count: f.key ? list.counts[f.key] : Object.entries(list.counts).filter(([k]) => k !== "needs_decision").reduce((n, [, v]) => n + v, 0) } : {}),
  }));

  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Posts</h1>
        {scope.can({ post: ["edit"] }) ? (
          <Link href={`/p/${projectSlug}/compose`} className={buttonStyles({ variant: "primary" })}>
            New post
          </Link>
        ) : null}
      </div>
      <FilterTabs label="Filter posts by status" tabs={tabs} />
      <div className="mt-4">
        {list === null ? (
          <p role="alert" className="text-sm text-danger">
            Posts couldn&apos;t be loaded. Reload the page to try again.
          </p>
        ) : list.items.length === 0 ? (
          <EmptyState
            message={status ? "No posts match this filter." : "No posts yet. Write your first post to see it here."}
            action={
              status ? (
                <Link href={hrefFor(projectSlug)} className="text-sm underline">
                  Show all posts
                </Link>
              ) : (
                <Link href={`/p/${projectSlug}/compose`} className="text-sm underline">
                  Write a post
                </Link>
              )
            }
          />
        ) : (
          <>
            <Table caption="Posts" columns={["Post", "Status", "Accounts", "When"]}>
              {list.items.map((p) => (
                <Row key={p.id}>
                  <Cell header>
                    <Link href={`/p/${projectSlug}/posts/${p.id}`} className="underline">
                      {p.excerpt || "(no text)"}
                    </Link>
                  </Cell>
                  <Cell>
                    {p.needsDecision ? <StatusBadge status="needs_decision" /> : <StatusBadge status={p.status} />}
                  </Cell>
                  <Cell>
                    <ul className="flex flex-wrap gap-1">
                      {p.targets.map((t) => (
                        <li key={t.id}>
                          <Badge tone={t.status === "failed" ? "danger" : t.status === "ambiguous" ? "warning" : t.status === "published" ? "success" : "neutral"}>
                            {t.accountName}: {t.status.replaceAll("_", " ")}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  </Cell>
                  <Cell>{p.relevantAt ? <LocalTime value={p.relevantAt} timeZone={tz} /> : "—"}</Cell>
                </Row>
              ))}
            </Table>
            <Pagination page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(n) => hrefFor(projectSlug, status, n)} />
          </>
        )}
      </div>
    </section>
  );
}
