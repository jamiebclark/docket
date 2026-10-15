import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AnnounceProvider } from "@/components/ui/Announce";
import { Badge } from "@/components/ui/Badge";
import { LocalTime } from "@/components/ui/LocalTime";
import { PageHeader } from "@/components/ui/PageHeader";
import { countingRuleName } from "@/providers/text";
import { findProvider } from "@/providers/registry";
import { forProject, NotFoundError } from "@/server/dal";
import { getSession } from "@/server/auth/session";
import { getInboxItem } from "@/server/services/engagement/inbox";
import { ReplyPanel } from "./ReplyPanel";

export const metadata: Metadata = { title: "Inbox item" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ projectSlug: string; itemId: string }> };

export default async function InboxItemPage({ params }: Props) {
  const { projectSlug, itemId } = await params;
  let scope;
  try {
    scope = await forProject(await getSession(), projectSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!scope.can({ engagement: ["view"] })) notFound();

  let item;
  try {
    item = await getInboxItem(scope, itemId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const tz = scope.project.timezone;
  const provider = findProvider(item.providerKey);
  const textCaps = provider?.capabilities.text ?? { maxLength: 0, countingRule: "code_points" as const };
  const canReply = scope.can({ engagement: ["reply"] });

  return (
    <AnnounceProvider focusFallbackId="page-title">
      <section>
        <PageHeader
          title={item.author.displayName ?? item.author.handle ?? "Unknown author"}
          titleId="page-title"
          description={
            <>
              {item.socialAccount.displayName} · <LocalTime value={item.saidAt} timeZone={tz} />
            </>
          }
        />

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {item.kind === "direct_message" ? <Badge tone="warning">Private — sent privately to one person</Badge> : null}
          {item.withdrawnAt ? <Badge tone="danger">Original withdrawn</Badge> : null}
          {item.editedUpstreamAt ? <Badge tone="warning">Edited since this draft was reviewed</Badge> : null}
          <Badge tone={item.state === "answered" ? "success" : item.state === "dismissed" ? "neutral" : "info"}>{item.state}</Badge>
        </div>

        {item.parent ? (
          <div className="mt-4 rounded-lg border border-border bg-muted px-3 py-2 text-sm">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">On</p>
            <p className="mt-1">{item.parent.text ?? item.parent.externalId ?? "—"}</p>
          </div>
        ) : null}

        <div className="mt-4 rounded-lg border border-border px-3 py-3 text-sm">
          <p>{item.text || "(no text)"}</p>
          {item.newerOnSameParent > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {item.newerOnSameParent} newer {item.newerOnSameParent === 1 ? "comment" : "comments"} on the same post.
            </p>
          ) : null}
        </div>

        {!item.replyable.ok ? (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Can&apos;t reply: {item.replyable.reason}
          </p>
        ) : null}

        <ReplyPanel
          slug={projectSlug}
          itemId={item.id}
          drafts={item.drafts}
          canReply={canReply}
          canDismiss={canReply}
          replyable={item.replyable.ok}
          dismissed={item.state === "dismissed"}
          countingRule={countingRuleName(textCaps.countingRule)}
          maxLength={textCaps.maxLength}
        />

        <p className="mt-6">
          <Link href={`/p/${projectSlug}/inbox`} className="text-sm underline">
            Back to inbox
          </Link>
        </p>
      </section>
    </AnnounceProvider>
  );
}
