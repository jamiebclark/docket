import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EmptyState } from "@/components/ui/EmptyState";
import { LocalTime } from "@/components/ui/LocalTime";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Cell, Row, Table } from "@/components/ui/Table";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { getLlmStatus } from "@/server/llm";
import { JOBS_PAGE_SIZE, listJobs } from "@/server/services/jobs/read";
import { APPROVAL_LABEL, SCHEDULING_LABEL } from "../generate/generate-logic";
import { UNREVIEWED_QUEUE_LABEL } from "../generate/PolicyPicker";

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const link = "text-sm underline";

export default async function JobsPage({ params, searchParams }: Props) {
  const { projectSlug } = await params;
  const raw = await searchParams;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const rawPage = Array.isArray(raw.page) ? raw.page[0] : raw.page;
  const page = Math.max(1, Number.parseInt(rawPage ?? "1", 10) || 1);
  const { items, total } = await listJobs(scope, { page });
  const canRun = scope.can({ generation: ["run"] });
  const llm = getLlmStatus();
  const base = `/p/${projectSlug}`;
  const actions = canRun ? (
    <div className="flex gap-4">
      <Link href={`${base}/media`} className={link}>
        New job from media
      </Link>
      <Link href={`${base}/jobs/new/csv`} className={link}>
        New job from CSV
      </Link>
    </div>
  ) : null;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        {actions}
      </div>
      {!llm.configured && (
        <p role="note" className="rounded-md border border-amber-700 p-3 text-sm">
          Generation is not configured. Set: {llm.problems.map((p) => p.name).join(", ")}.
        </p>
      )}
      {items.length === 0 ? (
        <EmptyState message="No generation jobs yet. Start one from your media library or a CSV file." action={actions} />
      ) : (
        <>
          <Table
            caption="Generation jobs"
            columns={["Source", "Created by", "Created", "Policies", "Status", "Queued", "Running", "Done", "Failed", "Cancelled"]}
          >
            {items.map((j) => (
              <Row key={j.id}>
                <Cell>
                  <Link href={`${base}/jobs/${j.id}`} className="underline">
                    {j.sourceSummary}
                  </Link>
                </Cell>
                <Cell>{j.createdBy?.name ?? "Removed member"}</Cell>
                <Cell>
                  <LocalTime value={j.createdAt} timeZone={scope.project.timezone} />
                </Cell>
                <Cell>
                  {j.unreviewedQueue ? UNREVIEWED_QUEUE_LABEL : `${APPROVAL_LABEL[j.approval]} + ${SCHEDULING_LABEL[j.scheduling]}`}
                </Cell>
                <Cell>
                  <StatusBadge status={j.status} />
                </Cell>
                <Cell>{j.counts.queued}</Cell>
                <Cell>{j.counts.running}</Cell>
                <Cell>{j.counts.done}</Cell>
                <Cell>{j.counts.failed}</Cell>
                <Cell>{j.counts.cancelled}</Cell>
              </Row>
            ))}
          </Table>
          <Pagination
            page={page}
            pageSize={JOBS_PAGE_SIZE}
            total={total}
            hrefFor={(n) => `${base}/jobs${n > 1 ? `?page=${n}` : ""}`}
          />
        </>
      )}
    </section>
  );
}
