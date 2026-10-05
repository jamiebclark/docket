import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TargetResolution } from "@/components/targets/TargetResolution";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FilterTabs } from "@/components/ui/FilterTabs";
import { LocalTime } from "@/components/ui/LocalTime";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { listFailures, failuresQuerySchema, type AttemptRun, type FailureList, type FailureRow } from "@/server/services/failures";
import { buttonStyles } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Failures" };
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ projectSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const KIND_LABEL = { slot: "Queue slot", explicit: "Chosen time", now: "Publish now" } as const;

function hrefFor(slug: string, status: string, account: string | undefined, page?: number): string {
  const qs = new URLSearchParams();
  if (status !== "all") qs.set("status", status);
  if (account) qs.set("account", account);
  if (page && page > 1) qs.set("page", String(page));
  const s = qs.toString();
  return `/p/${slug}/failures${s ? `?${s}` : ""}`;
}

function RunSummary({ run, tz }: { run: AttemptRun; tz: string }) {
  const [head] = run.entries;
  return (
    <>
      <td className="px-2 py-1">
        <LocalTime value={head!.at} timeZone={tz} />
      </td>
      <td className="px-2 py-1">{run.step}</td>
      <td className="px-2 py-1">
        {run.outcome.replaceAll("_", " ")}
        {run.count > 1 ? ` × ${run.count}` : ""}
        {run.error ? <div className="text-danger">{run.error}</div> : null}
      </td>
    </>
  );
}

function Pairs({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span aria-label="empty">—</span>;
  return (
    <ul className="space-y-0.5">
      {entries.map(([k, v]) => (
        <li key={k}>
          <code>
            {k}: {typeof v === "string" ? v : JSON.stringify(v)}
          </code>
        </li>
      ))}
    </ul>
  );
}

function AttemptLog({ row, tz }: { row: FailureRow; tz: string }) {
  const entries = row.attempts.reduce((n, r) => n + r.count, 0);
  return (
    <details>
      <summary className="cursor-pointer text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
        Attempt log ({entries} {entries === 1 ? "entry" : "entries"})
      </summary>
      <table className="mt-2 w-full border-collapse text-left text-xs">
        <caption className="sr-only">Attempt log for {row.account.name}</caption>
        <thead>
          <tr className="border-b border-border">
            {["Time", "Step", "Outcome", "Who", "Request", "Response"].map((c) => (
              <th key={c} scope="col" className="px-2 py-1 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {row.attempts.map((run) =>
            run.count === 1 ? (
              <tr key={run.entries[0]!.id} className="border-b border-border align-top">
                <RunSummary run={run} tz={tz} />
                <td className="px-2 py-1">{run.entries[0]!.actor.kind === "member" ? run.entries[0]!.actor.name : "System"}</td>
                <td className="px-2 py-1">
                  <Pairs value={run.entries[0]!.request} />
                </td>
                <td className="px-2 py-1">
                  <Pairs value={run.entries[0]!.response} />
                </td>
              </tr>
            ) : (
              <tr key={run.entries[0]!.id} className="border-b border-border align-top">
                <td colSpan={6} className="px-2 py-1">
                  <details>
                    <summary className="cursor-pointer">
                      {run.step} · {run.outcome.replaceAll("_", " ")} × {run.count}
                      {run.error ? ` — ${run.error}` : ""}
                    </summary>
                    <ul className="mt-1 space-y-1">
                      {run.entries.map((e) => (
                        <li key={e.id}>
                          <LocalTime value={e.at} timeZone={tz} /> · <Pairs value={e.request} /> · <Pairs value={e.response} />
                        </li>
                      ))}
                    </ul>
                  </details>
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </details>
  );
}

function AccountCell({ row }: { row: FailureRow }) {
  return (
    <>
      <div className="font-medium">{row.account.name}</div>
      {row.account.providerName ? <div className="text-xs">{row.account.providerName}</div> : null}
      {row.account.status === "removed" ? <Badge tone="danger">Removed account</Badge> : null}
      {row.account.status === "needs_reauth" ? <Badge tone="warning">Reconnect needed</Badge> : null}
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
  const query = failuresQuerySchema.parse({ status: first(raw.status), account: first(raw.account), page: first(raw.page) });
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
  const filtered = query.status !== "all" || !!query.account;

  return (
    <section>
      <h1 className="text-2xl font-semibold">Failures</h1>
      {list ? (
        <p className="mt-1 text-sm">
          {list.totals.ambiguous} need your decision · {list.totals.failed} failed
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-end gap-4">
        <FilterTabs label="Filter failures by status" tabs={tabs} />
        {list ? (
          <form method="get" action={`/p/${projectSlug}/failures`} className="flex items-end gap-2">
            {query.status !== "all" ? <input type="hidden" name="status" value={query.status} /> : null}
            <Select id="failures-account" name="account" label="Account" defaultValue={query.account ?? ""}>
              <option value="">All accounts</option>
              {list.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            <button type="submit" className={buttonStyles({ variant: "secondary" })}>
              Apply
            </button>
          </form>
        ) : null}
      </div>

      <div className="mt-4">
        {list === null ? (
          <p role="alert" className="text-sm text-danger">
            Failures couldn&apos;t be loaded. Reload the page to try again.
          </p>
        ) : empty ? (
          <EmptyState
            message={filtered ? "No posts match this filter." : "Nothing needs attention. Every post that was due went out or is still scheduled."}
            action={
              filtered ? (
                <Link href={`/p/${projectSlug}/failures`} className="text-sm underline">
                  Clear filters
                </Link>
              ) : (
                <Link href={`/p/${projectSlug}/posts`} className="text-sm underline">
                  View posts
                </Link>
              )
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                <caption className="sr-only">Posts that did not go out</caption>
                <thead>
                  <tr className="border-b border-border">
                    {["Account", "Post", `Meant to go out (${tz})`, "How", "Last error", "Attempts", "Actions"].map((c) => (
                      <th key={c} scope="col" className="px-2 py-2 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                {list.rows.map((row, i) => {
                  // Rows arrive ambiguous-first, so a group starts where the status first appears.
                  const heading =
                    list.rows.findIndex((r) => r.status === row.status) === i
                      ? row.status === "ambiguous"
                        ? "Needs your decision"
                        : "Failed"
                      : null;
                  return (
                    <tbody key={row.targetId}>
                      {heading ? (
                        <tr className="bg-muted">
                          <th scope="rowgroup" colSpan={7} className="px-2 py-1 text-left font-semibold">
                            {row.status === "ambiguous" ? <Badge tone="warning">{heading}</Badge> : <Badge tone="danger">{heading}</Badge>}
                          </th>
                        </tr>
                      ) : null}
                      <tr className="align-top">
                        <td className="px-2 py-2">
                          <AccountCell row={row} />
                        </td>
                        <td className="px-2 py-2">
                          <Link href={`/p/${projectSlug}/posts/${row.postId}`} className="underline">
                            {row.excerpt || "(no text)"}
                          </Link>
                        </td>
                        <td className="px-2 py-2">{row.intendedAt ? <LocalTime value={row.intendedAt} timeZone={tz} /> : "—"}</td>
                        <td className="px-2 py-2">{row.scheduleKind ? KIND_LABEL[row.scheduleKind] : "—"}</td>
                        <td className="px-2 py-2">{row.lastError ?? "—"}</td>
                        <td className="px-2 py-2">{row.attemptCount}</td>
                        <td className="px-2 py-2">
                          <TargetResolution
                            slug={projectSlug}
                            targetId={row.targetId}
                            accountName={row.account.name}
                            status={row.status}
                            actions={row.actions}
                            canSchedule={canSchedule}
                            variant="row"
                          />
                        </td>
                      </tr>
                      <tr className="border-b border-border">
                        <td colSpan={7} className="px-2 pb-2">
                          <AttemptLog row={row} tz={tz} />
                        </td>
                      </tr>
                    </tbody>
                  );
                })}
              </table>
            </div>
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
  );
}
