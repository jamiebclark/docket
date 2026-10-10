import { PageHeader } from "@/components/ui/PageHeader";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonStyles } from "@/components/ui/Button";
import { Checklist } from "@/components/ui/Checklist";
import { EmptyState } from "@/components/ui/EmptyState";
import { LocalTime } from "@/components/ui/LocalTime";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Cell, Row, Table } from "@/components/ui/Table";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { PREREQUISITES_TITLE } from "@/lib/roles/prerequisites";
import { mediaStatus } from "@/server/services/media";
import { JOBS_PAGE_SIZE, listJobs } from "@/server/services/jobs/read";
import { APPROVAL_LABEL, SCHEDULING_LABEL } from "../generate/generate-logic";
import { loadPrerequisites } from "../generate/prerequisites";
import { UNREVIEWED_QUEUE_LABEL } from "../generate/PolicyPicker";

export const metadata: Metadata = { title: "Batch jobs" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

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
  const prerequisites = canRun ? await loadPrerequisites(scope, projectSlug) : null;
  const storageOn = scope.can({ media: ["view"] }) ? (await mediaStatus(scope)).enabled : false;
  const base = `/p/${projectSlug}`;
  const actions =
    canRun && prerequisites === null ? (
      <div className="flex flex-wrap gap-2">
        <Link href={`${base}/jobs/new/csv`} className={buttonStyles({ variant: "primary" })}>
          New batch job from CSV
        </Link>
        {storageOn ? (
          <Link href={`${base}/media`} className={buttonStyles({ variant: "secondary" })}>
            Choose images in Media
          </Link>
        ) : null}
      </div>
    ) : null;

  return (
    <section className="flex flex-col gap-4">
      <PageHeader title="Batch jobs" description="Generate many posts at once from images or a CSV file." actions={actions} />
      {prerequisites ? <Checklist title={PREREQUISITES_TITLE} items={prerequisites} /> : null}
      {items.length === 0 ? (
        prerequisites ? null : (
          <EmptyState
            message={`No generation jobs yet. Start one from a CSV file${storageOn ? ", or choose images in Media" : ""}.`}
          />
        )
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
