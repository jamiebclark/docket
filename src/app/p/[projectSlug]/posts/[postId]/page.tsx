import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Icon, ProviderIcon } from "@/components/ui/Icon";
import { LocalTime } from "@/components/ui/LocalTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import * as posts from "@/server/services/posts";
import { groupAttemptRuns } from "@/server/services/failures";
import { preparingVideoLabel, type PostViewTarget } from "@/server/services/posts/view";
import { AnnounceProvider } from "@/components/ui/Announce";
import { DeliveryLog } from "@/components/targets/DeliveryLog";
import { PerformanceOverlay } from "@/components/targets/PerformanceOverlay";
import { PostMediaGallery } from "@/components/posts/PostMediaGallery";
import { TargetResolution } from "@/components/targets/TargetResolution";
import { safeExternalHref } from "@/lib/safe-redirect";
import { DeletePostButton } from "./DeletePostButton";
import { buttonStyles } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Post" };
export const dynamic = "force-dynamic";

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
      <article className="flex flex-col gap-6">
        <div>
          <p className="mb-2 text-sm">
            <Link href={`/p/${projectSlug}/posts`} className="underline">
              Posts
            </Link>
          </p>
          <PageHeader
            title="Post"
            titleId="page-title"
            description={`Where this post went, how it is doing, and what happened on the way. Times are in ${tz}.`}
            aside={<StatusBadge status={view.post.status} />}
            actions={
              <>
                {!started && scope.can({ post: ["edit"] }) ? (
                  <Link href={`/p/${projectSlug}/compose/${view.post.id}`} className={buttonStyles({ variant: "secondary" })}>
                    Edit
                  </Link>
                ) : null}
                <DeletePostButton slug={projectSlug} postId={view.post.id} canDelete={canDelete} deleteBlocked={view.deleteBlocked} />
              </>
            }
          />
        </div>

        {/*
          The post itself reads as the post: the copy at reading size beside its pictures, rather
          than a "Content" heading over a paragraph and a row of 80px chips. The media sits in a
          column of its own from `sm` up so a tall image does not push the text into a gutter.
        */}
        <Card>
          <div className="flex flex-col gap-4 sm:flex-row-reverse sm:items-start sm:gap-6">
            {view.media.length > 0 ? (
              <div className="sm:shrink-0">
                <PostMediaGallery media={view.media} />
              </div>
            ) : null}
            <p className="min-w-0 flex-1 text-base whitespace-pre-wrap">
              {view.post.baseText || <span className="text-muted-foreground">No text</span>}
            </p>
          </div>
        </Card>

        {/* The reason most people open this page, so it comes before the delivery detail. */}
        <PerformanceOverlay
          subjects={view.targets.map((t) => ({
            targetId: t.id,
            accountName: t.accountName,
            providerKey: t.providerKey,
            providerName: t.providerName,
            view: t.insights,
          }))}
          timeZone={tz}
        />

        <section aria-labelledby="accounts" className="flex flex-col gap-3">
          <h2 id="accounts" className="text-lg font-semibold">
            Accounts
          </h2>
          {view.targets.map((t) => (
            <TargetCard key={t.id} target={t} slug={projectSlug} timeZone={tz} canSchedule={canSchedule} />
          ))}
        </section>
      </article>
    </AnnounceProvider>
  );
}

/**
 * One account's delivery. The facts that used to be a six-row definition list — Account, Status,
 * Scheduled for, Published, Link, Attempts — are a heading line and one quiet line under it: the
 * account name already said the account, the attempt count is in the log's own summary, and only
 * the time that actually applies to this target's state is worth a line of its own.
 */
function TargetCard({
  target: t,
  slug,
  timeZone,
  canSchedule,
}: {
  target: PostViewTarget;
  slug: string;
  timeZone: string;
  canSchedule: boolean;
}) {
  const href = t.externalUrl ? safeExternalHref(t.externalUrl) : null;
  return (
    <Card as="section" aria-labelledby={`target-${t.id}`}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ProviderIcon providerKey={t.providerKey} size={32} />
            <div className="min-w-0">
              <h3 id={`target-${t.id}`} className="truncate font-semibold">
                {t.accountName}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t.providerName}
                {t.publishedAt ? (
                  <>
                    {" · Published "}
                    <LocalTime value={t.publishedAt} timeZone={timeZone} />
                  </>
                ) : t.scheduledAt ? (
                  <>
                    {" · "}
                    {t.scheduleKind === "now" ? "Publishing now, asked for " : t.scheduleKind === "explicit" ? "Due " : "Queue slot "}
                    <LocalTime value={t.scheduledAt} timeZone={timeZone} />
                  </>
                ) : null}
                {t.note ? ` · ${t.note}` : null}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={t.status} />
            {href ? (
              <a href={href} rel="noopener noreferrer" target="_blank" className="inline-flex items-center gap-1 text-sm underline">
                View on {t.providerName}
                <Icon name="externalLink" size={14} />
              </a>
            ) : null}
          </div>
        </div>

        {t.preparingVideo || t.inProgress ? (
          <p className="text-sm text-muted-foreground">{t.preparingVideo ? `${preparingVideoLabel(t.providerName)}…` : "Publishing now…"}</p>
        ) : null}

        {t.lastError ? <p className="text-sm text-danger">{t.lastError}</p> : null}

        {t.status === "ambiguous" ? (
          <div role="group" aria-label="Needs your decision" className="rounded-lg border border-warning-border bg-warning-bg p-3 text-warning">
            <p className="font-medium">
              <Badge tone="warning">Needs your decision</Badge>
            </p>
            <p className="mt-2 text-sm">
              We sent this post but never heard back, so we can&apos;t tell whether it went out. Check {t.accountName}, then record what you
              found.
            </p>
          </div>
        ) : null}

        <TargetResolution
          slug={slug}
          targetId={t.id}
          accountId={t.accountId}
          timeZone={timeZone}
          accountName={t.accountName}
          status={t.status}
          actions={t.actions}
          canSchedule={canSchedule}
          variant="detail"
        />

        <DeliveryLog runs={groupAttemptRuns(t.attempts)} timeZone={timeZone} accountName={t.accountName} />
      </div>
    </Card>
  );
}
