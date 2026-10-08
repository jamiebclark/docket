import type { Metadata } from "next";
import { attemptActorLabel } from "@/lib/failures/attempt-actor";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { LocalTime } from "@/components/ui/LocalTime";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as posts from "@/server/services/posts";
import { preparingVideoLabel } from "@/server/services/posts/view";
import { AnnounceProvider } from "@/components/ui/Announce";
import { TargetResolution } from "@/components/targets/TargetResolution";
import { safeExternalHref } from "@/lib/safe-redirect";
import { DeletePostButton } from "./DeletePostButton";
import { buttonStyles } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Post" };
export const dynamic = "force-dynamic";

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

export default async function PostPage({ params }: { params: Promise<{ projectSlug: string; postId: string }> }) {
  const { projectSlug, postId } = await params;
  let scope;
  let view;
  try {
    scope = await forProject(await getSession(), projectSlug);
    view = await posts.getPostView(scope, postId);
  } catch (error) {
    // A malformed id is a ZodError from the service; to the visitor it is simply not found.
    if (error instanceof NotFoundError || (error instanceof Error && error.name === "ZodError")) notFound();
    throw error;
  }
  const tz = scope.project.timezone;
  const canSchedule = scope.can({ post: ["schedule"] });
  const canDelete = scope.can({ post: ["delete"] });
  const started = view.targets.some((t) => ["publishing", "published", "ambiguous"].includes(t.status));

  return (
    <AnnounceProvider focusFallbackId="page-title">
    <article className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm">
            <Link href={`/p/${projectSlug}/posts`} className="underline">
              Posts
            </Link>
          </p>
          <h1 id="page-title" tabIndex={-1} className="mt-1 text-2xl font-semibold">
            Post
          </h1>
          <p className="mt-1">
            <StatusBadge status={view.post.status} />
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!started && scope.can({ post: ["edit"] }) ? (
            <Link href={`/p/${projectSlug}/compose/${view.post.id}`} className={buttonStyles({ variant: "secondary" })}>
              Edit
            </Link>
          ) : null}
          <DeletePostButton slug={projectSlug} postId={view.post.id} canDelete={canDelete} deleteBlocked={view.deleteBlocked} />
        </div>
      </header>

      <section aria-labelledby="content">
        <h2 id="content" className="text-lg font-semibold">
          Content
        </h2>
        <p className="mt-2 whitespace-pre-wrap">{view.post.baseText || "(no text)"}</p>
        {view.media.length > 0 ? (
          <ul className="mt-3 flex flex-wrap gap-2">
            {view.media.map((m) => (
              <li key={m.id}>
                {m.deleted ? (
                  <span className="inline-flex h-20 w-20 items-center justify-center rounded border border-dashed border-border p-1 text-center text-xs">Image deleted</span>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.thumbnailUrl} alt={m.altText} className="h-20 w-20 rounded object-cover" />
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {view.targets.map((t) => (
        <section key={t.id} aria-labelledby={`target-${t.id}`} className="rounded-xl border border-border bg-surface p-5 shadow-card">
          <h2 id={`target-${t.id}`} className="text-lg font-semibold">
            {t.accountName}
          </h2>
          <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="font-medium">Account</dt>
            <dd>
              {t.accountName} ({t.providerName})
            </dd>
            <dt className="font-medium">Status</dt>
            <dd>
              <StatusBadge status={t.status} />
              {t.preparingVideo ? <span className="ml-2">{preparingVideoLabel(t.providerName)}…</span> : null}
              {t.inProgress ? <span className="ml-2">Publishing now…</span> : null}
            </dd>
            {t.scheduledAt ? (
              <>
                <dt className="font-medium">Scheduled for</dt>
                <dd>
                  <LocalTime value={t.scheduledAt} timeZone={tz} /> ({tz}
                  {t.scheduleKind === "now" ? ", published now" : t.scheduleKind === "explicit" ? ", chosen time" : ", queue slot"})
                </dd>
              </>
            ) : null}
            {t.publishedAt ? (
              <>
                <dt className="font-medium">Published</dt>
                <dd>
                  <LocalTime value={t.publishedAt} timeZone={tz} />
                </dd>
              </>
            ) : null}
            {t.externalUrl ? (
              <>
                <dt className="font-medium">Link</dt>
                <dd>
                  {safeExternalHref(t.externalUrl) ? (
                    <a href={safeExternalHref(t.externalUrl)!} rel="noopener noreferrer" target="_blank" className="underline">
                      View on {t.providerName}
                    </a>
                  ) : (
                    t.externalUrl
                  )}
                </dd>
              </>
            ) : null}
            <dt className="font-medium">Attempts</dt>
            <dd>{t.attemptCount}</dd>
            {t.lastError ? (
              <>
                <dt className="font-medium">Last error</dt>
                <dd className="text-danger">{t.lastError}</dd>
              </>
            ) : null}
          </dl>

          {t.status === "ambiguous" ? (
            <div role="group" aria-label="Needs your decision" className="mt-3 rounded-md border border-warning-border bg-warning-bg p-3 text-warning">
              <p className="font-medium">
                <Badge tone="warning">Needs your decision</Badge>
              </p>
              <p className="mt-2 text-sm">
                We sent this post but never heard back, so we can&apos;t tell whether it went out. Check {t.accountName}, then record what you found.
              </p>
            </div>
          ) : null}

          <div className="mt-3">
            <TargetResolution slug={projectSlug} targetId={t.id} accountId={t.accountId} timeZone={tz} accountName={t.accountName} status={t.status} actions={t.actions} canSchedule={canSchedule} variant="detail" />
          </div>

          <h3 className="mt-4 text-sm font-semibold">Attempts</h3>
          {t.attempts.length === 0 ? (
            <p className="mt-1 text-sm">No attempts yet.</p>
          ) : (
            <table className="mt-1 w-full border-collapse text-left text-xs">
              <caption className="sr-only">Attempts for {t.accountName}</caption>
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
                {t.attempts.map((a) => (
                  <tr key={a.id} className="border-b border-border align-top">
                    <td className="px-2 py-1">
                      <LocalTime value={a.at} timeZone={tz} />
                    </td>
                    <td className="px-2 py-1">{a.step}</td>
                    <td className="px-2 py-1">
                      {a.outcome.replaceAll("_", " ")}
                      {a.error ? <div className="text-danger">{a.error}</div> : null}
                    </td>
                    <td className="px-2 py-1">{attemptActorLabel(a.actor)}</td>
                    <td className="px-2 py-1">
                      <Pairs value={a.request} />
                    </td>
                    <td className="px-2 py-1">
                      <Pairs value={a.response} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </article>
    </AnnounceProvider>
  );
}
