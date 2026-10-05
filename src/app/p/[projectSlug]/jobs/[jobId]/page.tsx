import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/ui/AutoRefresh";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { LiveRegion } from "@/components/ui/LiveRegion";
import { LocalTime } from "@/components/ui/LocalTime";
import { Pagination } from "@/components/ui/Pagination";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getSession } from "@/server/auth/session";
import { forProject, NotFoundError } from "@/server/dal";
import { getLlmStatus } from "@/server/llm";
import { getJob, JOB_ITEMS_PAGE_SIZE, listJobItems } from "@/server/services/jobs";
import { APPROVAL_LABEL, SCHEDULING_LABEL } from "../../generate/generate-logic";
import { UNREVIEWED_QUEUE_LABEL } from "../../generate/PolicyPicker";
import { CancelJobDialog } from "./CancelJobDialog";
import { CloseJobDialog } from "./CloseJobDialog";
import { JobItemsTable } from "./JobItemsTable";
import { RetryButton } from "./RetryButtons";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string; jobId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function load(projectSlug: string, jobId: string) {
  try {
    const scope = await forProject(await getSession(), projectSlug);
    return { scope, job: await getJob(scope, jobId) };
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { projectSlug, jobId } = await params;
  const { job } = await load(projectSlug, jobId);
  return { title: `Job: ${job.sourceSummary}` };
}

export default async function JobPage({ params, searchParams }: Props) {
  const { projectSlug, jobId } = await params;
  const raw = await searchParams;
  const { scope, job } = await load(projectSlug, jobId);
  const tab = one(raw.status) === "failed" ? "failed" : one(raw.status) === "done" ? "done" : "all";
  const page = Math.max(1, Number.parseInt(one(raw.page) ?? "1", 10) || 1);
  const { items, total } = await listJobItems(scope, jobId, { page, ...(tab === "all" ? {} : { status: tab }) });
  const tz = scope.project.timezone;
  const base = `/p/${projectSlug}/jobs/${jobId}`;
  const active = job.status === "queued" || job.status === "running";
  const canRun = scope.can({ generation: ["run"] });
  const c = job.counts;
  const announce = `${c.done} done, ${c.failed} failed, ${c.queued} queued`;
  const llm = getLlmStatus();

  return (
    <section className="flex flex-col gap-4">
      <AutoRefresh active={active} intervalMs={5000} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{job.sourceSummary}</h1>
        <StatusBadge status={job.status} />
        {job.open && job.status !== "cancelled" ? (
          <span className="rounded border border-info-border px-2 py-0.5 text-xs font-medium text-info">
            Open: accepting items
          </span>
        ) : null}
      </div>
      <div className="text-sm">
        <p>
          Created by {job.createdBy?.name ?? "Removed member"} on <LocalTime value={job.createdAt} timeZone={tz} />
        </p>
        {job.cancelledAt ? (
          <p>
            Cancelled <LocalTime value={job.cancelledAt} timeZone={tz} />
          </p>
        ) : job.finishedAt ? (
          <p>
            Finished <LocalTime value={job.finishedAt} timeZone={tz} />
          </p>
        ) : null}
      </div>

      {active && !llm.configured ? (
        <p role="note" className="rounded-md border border-warning-border p-3 text-sm">
          Generation is not configured, so these items are waiting. Set: {llm.problems.map((p) => p.name).join(", ")}.
        </p>
      ) : null}
      {active && !job.jobsRunnable.ok ? (
        <p role="note" className="rounded-md border border-warning-border p-3 text-sm">
          Jobs cannot run: {job.jobsRunnable.message}
        </p>
      ) : null}

      <dl className="grid max-w-2xl grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="font-medium">Voice</dt>
        <dd>
          {job.voice.name}, version {job.voice.version}
          {job.voice.archived ? " (archived)" : ""}
        </dd>
        <dt className="font-medium">Template</dt>
        <dd>
          <pre className="whitespace-pre-wrap font-mono text-xs">{job.template}</pre>
        </dd>
        <dt className="font-medium">Targets</dt>
        <dd>{job.targets.map((t) => (t.removed ? `${t.displayName} (removed)` : t.displayName)).join(", ")}</dd>
        <dt className="font-medium">Posting instructions (as of job creation)</dt>
        <dd>
          <ul className="flex flex-col gap-1">
            {job.targets.map((t) => (
              <li key={t.id}>
                <span className="font-medium">{t.displayName}:</span>{" "}
                {t.instructions === "not_recorded" ? (
                  <span className="text-muted-foreground">Not recorded: uses each account&apos;s current instructions</span>
                ) : t.instructions === null ? (
                  <span className="text-muted-foreground">None</span>
                ) : (
                  <span className="whitespace-pre-wrap">{t.instructions}</span>
                )}
              </li>
            ))}
          </ul>
        </dd>
        <dt className="font-medium">Policies</dt>
        <dd>{job.unreviewedQueue ? UNREVIEWED_QUEUE_LABEL : `${APPROVAL_LABEL[job.approval]} + ${SCHEDULING_LABEL[job.scheduling]}`}</dd>
      </dl>

      <dl aria-label="Counts" className="flex flex-wrap gap-6 text-sm">
        {(
          [
            ["Queued", c.queued],
            ["Running", c.running],
            ["Done", c.done],
            ["Failed", c.failed],
            ["Cancelled", c.cancelled],
          ] as const
        ).map(([label, n]) => (
          <div key={label}>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className="text-xl font-semibold">{n}</dd>
          </div>
        ))}
      </dl>
      <LiveRegion message={announce} />

      {canRun && job.status !== "cancelled" ? (
        <div className="flex gap-2">
          {c.failed > 0 ? <RetryButton slug={projectSlug} jobId={jobId} count={c.failed} /> : null}
          {job.open ? <CloseJobDialog slug={projectSlug} jobId={jobId} summary={job.sourceSummary} /> : null}
          {active ? <CancelJobDialog slug={projectSlug} jobId={jobId} summary={job.sourceSummary} /> : null}
        </div>
      ) : null}

      <FilterTabs
        label="Show items"
        tabs={[
          { label: "All", href: base, active: tab === "all" },
          { label: "Failed", href: `${base}?status=failed`, active: tab === "failed" },
          { label: "Done", href: `${base}?status=done`, active: tab === "done" },
        ]}
      />
      <JobItemsTable slug={projectSlug} jobId={jobId} items={items} canRetry={canRun && job.status !== "cancelled"} />
      <Pagination
        page={page}
        pageSize={JOB_ITEMS_PAGE_SIZE}
        total={total}
        hrefFor={(n) => `${base}?${new URLSearchParams({ ...(tab === "all" ? {} : { status: tab }), ...(n > 1 ? { page: String(n) } : {}) }).toString()}`}
      />
    </section>
  );
}
