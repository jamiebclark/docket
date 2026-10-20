import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { LocalTime } from "@/components/ui/LocalTime";
import { countingRuleName } from "@/providers/text";
import type { InboxItemView } from "@/server/services/engagement/inbox";
import { ReplyPanel } from "@/app/p/[projectSlug]/inbox/[itemId]/ReplyPanel";

/**
 * One inbox item, read and answered. Shared by the item route and the list's detail pane
 * (design-system.md §19) so the pane is the real thing rather than a summary that drifts from it.
 *
 * `heading` is the route's `h1`; in the pane the list already owns the page heading, so it renders
 * an `h2` instead and the pane keeps its own labelled region.
 */
export function InboxItemDetail({
  item,
  projectSlug,
  tz,
  canReply,
  maxLength,
  countingRule,
  headingLevel = 1,
  headingId,
}: {
  item: InboxItemView;
  projectSlug: string;
  tz: string;
  canReply: boolean;
  maxLength: number;
  countingRule: Parameters<typeof countingRuleName>[0];
  headingLevel?: 1 | 2;
  headingId?: string;
}) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const author = item.author.displayName ?? item.author.handle ?? "Unknown author";

  return (
    <div>
      <div>
        <Heading id={headingId} className={headingLevel === 1 ? "text-2xl font-semibold text-heading" : "text-lg font-semibold text-heading"}>
          {author}
        </Heading>
        <p className="mt-1 text-sm text-muted-foreground">
          {item.socialAccount.displayName} · <LocalTime value={item.saidAt} timeZone={tz} />
        </p>
      </div>

      {/* Badge the exception, never the norm (§19): `waiting` is the resting state and says nothing. */}
      {item.kind === "direct_message" || item.withdrawnAt || item.editedUpstreamAt || item.state !== "waiting" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {item.kind === "direct_message" ? <Badge tone="warning">Private — sent privately to one person</Badge> : null}
          {item.withdrawnAt ? <Badge tone="danger">Original withdrawn</Badge> : null}
          {item.editedUpstreamAt ? <Badge tone="warning">Edited since this draft was reviewed</Badge> : null}
          {item.state !== "waiting" ? <Badge tone={item.state === "answered" ? "success" : "neutral"}>{item.state}</Badge> : null}
        </div>
      ) : null}

      {/*
        Context, not a message: a plain bordered block with no `role`, so a screen reader is not
        told about the quoted post as though it were an announcement (§18).
      */}
      <div className="mt-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
        {item.parent === null ? (
          <p className="text-muted-foreground">This is not about one of your posts.</p>
        ) : (
          <>
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {item.parent.kind === "docket_post" ? "On your post" : "On a post that is not one of yours"}
            </p>
            <p className="mt-1">
              {item.parent.kind === "docket_post" ? item.parent.text || "(no text)" : item.parent.externalId}
            </p>
          </>
        )}
      </div>

      <blockquote className="mt-4 rounded-lg border border-border px-3 py-3">
        <p className="whitespace-pre-wrap">{item.text || "(no text)"}</p>
        {item.newerOnSameParent > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {item.newerOnSameParent} newer {item.newerOnSameParent === 1 ? "comment" : "comments"} on the same post.
          </p>
        ) : null}
      </blockquote>

      {!item.replyable.ok ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          {item.replyable.reason}
        </p>
      ) : null}

      <ReplyPanel
        slug={projectSlug}
        itemId={item.id}
        drafts={item.drafts}
        canReply={canReply}
        canDismiss={canReply}
        replyable={item.replyable.ok}
        dismissed={item.state !== "waiting"}
        countingRule={countingRuleName(countingRule)}
        maxLength={maxLength}
        tz={tz}
      />

      {headingLevel === 1 ? (
        <p className="mt-6">
          <Link href={`/p/${projectSlug}/inbox`} className="text-sm underline">
            Back to inbox
          </Link>
        </p>
      ) : null}
    </div>
  );
}
