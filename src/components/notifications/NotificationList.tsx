import Link from "next/link";
import type { RowDone } from "@/app/notifications/actions";
import { Badge } from "@/components/ui/Badge";
import { cellLinkStyles } from "@/components/ui/controls";
import { Icon, ProviderIcon } from "@/components/ui/Icon";
import { RelativeTime } from "@/components/ui/RelativeTime";
import { OUTCOME_TONE } from "@/lib/activity/outcomes";
import type { NotificationItem } from "@/lib/notifications/types";
import { NotificationRowActions } from "./NotificationRowActions";

/** Everything that qualifies the problem, as one quiet line: who it was for, where, and when. */
function metaOf(item: NotificationItem): string {
  const platforms = item.platforms.map((p) => p.name).join(" and ");
  return [item.project.name, platforms, item.accountName, item.postDeleted ? "Post deleted" : null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/**
 * The problems, newest first. Shared by the header panel and `/notifications`; no server-only imports.
 *
 * A row is three parts, not four stacked lines of equal weight: a platform mark in a fixed leading
 * column so every row shares a left edge and reads as one object, the **message** as the headline
 * (it is the only part that says what happened), and one `Sub`-quiet line carrying everything that
 * merely qualifies it. The status badge rides at the trailing edge — it is a category, and in first
 * position it outshouted the sentence underneath that said the same thing in words.
 *
 * Deliberately not a bordered card: these rows sit inside the "Recent problems" card and inside the
 * bell's popover, so a third frame would fight both. The leading column, the padding and the hover
 * surface carry the object-ness instead.
 */
export function NotificationList({
  items,
  now,
  returnTo,
  onRowDone,
}: {
  items: NotificationItem[];
  now: Date;
  returnTo?: "/notifications";
  onRowDone?: (result: RowDone) => void;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No problems in your projects.</p>;
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => {
        // One mark, always the same size, so the column never shifts. A connect group names all of
        // its platforms in the meta line below, and the mark is decorative, so showing the first is
        // no loss; an event with no platform at all keeps the column with a neutral glyph.
        const mark = item.platforms[0];
        return (
          <li key={item.id} className="flex gap-3 rounded-lg px-2 py-3 text-sm transition-colors hover:bg-muted/40">
            <span className="shrink-0 pt-0.5">
              {mark ? (
                <ProviderIcon providerKey={mark.key} size={28} />
              ) : (
                <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon name="failures" size={16} />
                </span>
              )}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
                <p className="min-w-0 font-medium text-foreground">
                  {item.link ? (
                    <Link href={item.link.href} prefetch={false} className={cellLinkStyles}>
                      {item.message}
                    </Link>
                  ) : (
                    item.message
                  )}
                </p>
                {/* `ml-auto` as well as `justify-between`: in the bell's narrow popover a long
                    message pushes the badges onto their own line, and without this they would land
                    at its start — right-aligned on one row, left on the next. */}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {item.isNew ? <Badge tone="brand">New</Badge> : null}
                  <Badge tone={OUTCOME_TONE[item.outcome]}>{item.outcomeLabel}</Badge>
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {metaOf(item)}
                {" · "}
                <RelativeTime value={item.occurredAt} timeZone={item.project.timeZone} now={now} />
              </p>
              <div className="mt-1">
                <NotificationRowActions item={item} returnTo={returnTo} onDone={onRowDone} />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
